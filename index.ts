import { Elysia, t } from 'elysia';
import { staticPlugin } from '@elysiajs/static';
import { Innertube, Platform, Types, UniversalCache, type YTNodes } from 'youtubei.js/web';
import ffmpeg from 'ffmpeg-static';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import instaHandler from './api/insta';
import instav2Handler from './api/instav2';
import fbHandler from './api/fb';
import pinHandler, { searchPinterest, getCacheStats, clearCaches } from './api/pin';
import ttHandler from './api/tt';
import xHandler from './api/x';

Platform.shim.eval = async (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
  const properties = [];
  if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  const code = `${data.output}
return { ${properties.join(', ')} }`;
  return new Function(code)();
};

const PORT = 3040;
const BUN_IDLE_TIMEOUT = 255;
const EXPIRATION_SECONDS = 180;
const MAX_CONCURRENT_DOWNLOADS = 16;
const DOWNLOAD_CHUNK_SIZE_MB = 10;
const COOKIE_FILE_PATH = 'cookies.txt';
const CACHE_EXPIRATION_MS = 3 * 60 * 1000;

function getClientId(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfConnecting = request.headers.get('cf-connecting-ip');
  return forwarded?.split(',')[0].trim() || realIp || cfConnecting || 'unknown';
}

type YTFormat = YTNodes.Format & {
  content_length: number,
  is_original?: boolean,
  deciphered_url?: string
};

interface DownloadTask {
  index: number;
  format: YTFormat;
  start: number;
  end: number;
  description: string;
  retries: number;
}

interface DownloadSession {
  status: 'pending' | 'downloading' | 'merging' | 'completed' | 'error';
  videoFormat?: YTFormat;
  audioFormat: YTFormat;
  tempDir: string;
  tempVideoFile?: string;
  tempAudioFile: string;
  finalFilename: string;
  finalFilePath: string;
  videoTasks: DownloadTask[];
  audioTasks: DownloadTask[];
  error?: string;
  isAudioOnly: boolean;
  createdAt: number;
  cleanupTimeoutId: NodeJS.Timeout | null;
}

interface CacheEntry {
  timestamp: number;
  data: any;
}

const downloadSessions = new Map<string, DownloadSession>();
const infoCache = new Map<string, CacheEntry>();
let yt: Innertube;

async function getCookieFileContent(cookieFilePath: string): Promise<string> {
  const cookieFile = Bun.file(cookieFilePath);
  if (!(await cookieFile.exists())) {
    return '';
  }
  try {
    const content = await cookieFile.text();
    return content;
  } catch {
    return '';
  }
}

function getVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^/(shorts|live|embed)/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
    if (u.hostname.includes('youtu.be')) return u.pathname.split('/')[1];
  } catch {}
  return null;
}

function formatBytes(bytes: number, decimals = 2): string {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${['Bytes', 'KiB', 'MiB', 'GiB'][i]}`;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds >= 60) {
    const m = Math.floor(totalSeconds / 60);
    return `${m} minute${m > 1 ? 's' : ''}`;
  }
  const s = Math.floor(totalSeconds);
  return `${s} second${s > 1 ? 's' : ''}`;
}

async function downloadAndCombineManager(sessionId: string, tasks: DownloadTask[], destinationFile: string) {
  const startTime = performance.now();
  const totalSize = tasks.reduce((sum, t) => sum + (t.end - t.start + 1), 0);
  const actualWorkers = Math.min(tasks.length, MAX_CONCURRENT_DOWNLOADS);
  const downloadedChunks = new Map<number, Buffer>();
  let chunksWritten = 0;
  const writer = Bun.file(destinationFile).writer();
  const processTask = async (task: DownloadTask, workerId: number) => {
    let attempt = 0;
    const url = task.format.deciphered_url;
    if (!url) throw new Error(`Task ${task.description} missing deciphered URL.`);
    while (attempt <= task.retries) {
      try {
        const resp = await fetch(url, {
          headers: { 'Range': `bytes=${task.start}-${task.end}` }
        });
        if (!resp.ok) throw new Error(`Fetch failed with status ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        downloadedChunks.set(task.index, buf);
        while (downloadedChunks.has(chunksWritten)) {
          writer.write(downloadedChunks.get(chunksWritten)!);
          downloadedChunks.delete(chunksWritten);
          chunksWritten++;
        }
        return;
      } catch {
        if (attempt < task.retries) {
          attempt++;
          await new Promise(r => setTimeout(r, 250 * attempt));
        } else throw new Error(`Task ${task.description} failed permanently.`);
      }
    }
  };
  const tasksToProcess = [...tasks];
  const workerPromises = Array.from({ length: actualWorkers }, (_, i) => {
    const id = i + 1;
    return (async () => {
      while (tasksToProcess.length > 0) {
        const task = tasksToProcess.shift();
        if (task) await processTask(task, id);
      }
    })();
  });
  await Promise.all(workerPromises);
  await writer.end();
}

async function cleanupSession(sessionId: string) {
  const session = downloadSessions.get(sessionId);
  if (session) {
    if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);
    downloadSessions.delete(sessionId);
    await rm(session.tempDir, { recursive: true, force: true });
  }
}

function scheduleSessionCleanup(sessionId: string, delayMs: number) {
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);
  session.cleanupTimeoutId = setTimeout(() => cleanupSession(sessionId), delayMs);
}

const app = new Elysia()
  .use(staticPlugin({ assets: 'public', prefix: '', alwaysStatic: true }))
  .onStart(async () => {
    await mkdir(join(process.cwd(), 'temp'), { recursive: true });
    const cookie = await getCookieFileContent(COOKIE_FILE_PATH);
    yt = await Innertube.create({ cookie, cache: new UniversalCache(true), player_id: '0004de42' });
  })
  .onAfterHandle(({ response, set }) => {
    if (typeof response === 'object' && response !== null && !(response instanceof Response)) {
      set.headers['Content-Type'] = 'application/json;charset=utf-8';
      return JSON.stringify(response, null, 2);
    }
    return response;
  })
  .onError(({ code, error, set }) => {
    set.status = code === 'VALIDATION' ? 400 : 500;
    return { status: 'error', message: error.toString() };
  })
  .get('/', () => new Response(Bun.file('public/home.html')))
  .get('/robots.txt', () => new Response(['User-agent: *', 'Disallow: /'].join('
'), { headers: { 'Content-Type': 'text/plain' } }))
  .get('/insta', async ({ query }) => {
    const { url } = query;
    return await instaHandler(url);
  }, { query: t.Object({ url: t.String() }) })
  .get('/instav2', async ({ query }) => {
    const { url } = query;
    return await instav2Handler(url);
  }, { query: t.Object({ url: t.String() }) })
  .get('/fb', async ({ query }) => {
    const { url } = query;
    return await fbHandler(url);
  }, { query: t.Object({ url: t.String() }) })
  .get('/tt', async ({ query }) => {
    const { url } = query;
    return await ttHandler(url);
  }, { query: t.Object({ url: t.String() }) })
  .get('/x', async ({ query }) => {
    const { url } = query;
    return await xHandler(url);
  }, { query: t.Object({ url: t.String() }) })
  .get('/pin', async ({ query, request, set }) => {
    const { url, search, limit } = query;
    const clientId = getClientId(request);
    if (search) {
      const searchLimit = limit ? Math.min(parseInt(limit), 50) : 20;
      const result = await searchPinterest(search as string, clientId, searchLimit);
      if (result.status === 'rate_limited') {
        set.status = 429;
        set.headers['Retry-After'] = '60';
      }
      return result;
    } else if (url) {
      const result = await pinHandler(url as string, clientId);
      if (result.status === 'rate_limited') {
        set.status = 429;
        set.headers['Retry-After'] = '60';
      }
      return result;
    } else {
      set.status = 400;
      return { status: 'error', error: 'Missing required parameter: "url" for extraction or "search" for search.' };
    }
  }, { query: t.Object({ url: t.Optional(t.String()), search: t.Optional(t.String()), limit: t.Optional(t.String()) }) })
  .get('/pin/stats', () => getCacheStats())
  .post('/pin/cache/clear', () => {
    clearCaches();
    return { status: 'success', message: 'All Pinterest caches cleared' };
  })
  .get('/yt', async ({ query, request }) => {
    const { url: videoUrl, quality, format } = query;
    const isAudioRequest = format === 'm4a';
    const videoId = getVideoId(videoUrl);
    if (!videoId) throw new Error("Invalid YouTube URL.");
    const cappedQuality = Math.min(parseInt(quality || '1080'), 1080);
    const cacheKey = isAudioRequest ? `${videoId}-audio` : `${videoId}-video-${cappedQuality}p`;
    const cachedItem = infoCache.get(cacheKey);

    if (cachedItem && (Date.now() - cachedItem.timestamp < CACHE_EXPIRATION_MS)) {
      const { sessionData, responseData } = cachedItem.data;
      const newSessionId = crypto.randomUUID();
      const tempDir = join(process.cwd(), 'temp', newSessionId);

      await mkdir(tempDir, { recursive: true });

      const newSession: DownloadSession = {
        ...sessionData,
        tempDir,
        tempVideoFile: sessionData.tempVideoFile ? join(tempDir, 'video.mp4') : undefined,
        tempAudioFile: join(tempDir, 'audio.m4a'),
        finalFilename: sessionData.finalFilename,
        finalFilePath: join(tempDir, sessionData.finalFilename),
        createdAt: Date.now(),
        cleanupTimeoutId: null
      };

      downloadSessions.set(newSessionId, newSession);
      scheduleSessionCleanup(newSessionId, EXPIRATION_SECONDS * 1000);
      const requestUrl = new URL(request.url);

      return { ...responseData,
        cached: true,
        downloadLink: `${requestUrl.protocol}//${requestUrl.host}/stream/${isAudioRequest ? 'audio' : 'video'}/${newSessionId}`
      };
    }

    const info = await yt.getInfo(videoId, { client: 'TV' });

    if (info.playability_status?.status !== 'OK') throw new Error(`Video not playable: ${info.playability_status?.reason}`);
    if (!info.streaming_data) throw new Error('No streaming data found.');
    const title = info.primary_info?.title?.text || 'video';
    const channel = info.secondary_info?.owner?.author?.name || 'channel';
    const safeTitle = title.replace(/[^a-zA-Z0-9 ._-]/g, '').trim();
    const safeChannel = channel.replace(/[^a-zA-Z0-9 ._-]/g, '').trim();
    const allM4aAudio = info.streaming_data.adaptive_formats.filter(f => f.has_audio && !f.has_video && f.mime_type?.includes('mp4a')) as YTFormat[];
    if (allM4aAudio.length === 0) throw new Error('No AAC (.m4a) audio track found.');
    const audioFormat = allM4aAudio.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    if (!audioFormat.content_length) throw new Error('Selected audio format is missing size info.');

    audioFormat.deciphered_url = await audioFormat.decipher();
    if (!audioFormat.deciphered_url) throw new Error("Failed to decipher audio URL.");

    const sessionId = crypto.randomUUID();
    const tempDir = join(process.cwd(), 'temp', sessionId);

    await mkdir(tempDir, { recursive: true });

    const audioTasks: DownloadTask[] = [];
    const targetChunkSizeBytes = DOWNLOAD_CHUNK_SIZE_MB * 1024 * 1024;
    for (let i = 0, start = 0; start < audioFormat.content_length; i++) {
      const end = Math.min(start + targetChunkSizeBytes - 1, audioFormat.content_length - 1);
      audioTasks.push({
        index: i,
        format: audioFormat,
        start,
        end,
        retries: 3,
        description: `Audio Chunk ${i + 1}`
      });
      start = end + 1;
    }

    let session: DownloadSession;
    let responsePayload: any;
    const requestUrl = new URL(request.url);

    if (isAudioRequest) {
      const finalFilename = `${safeTitle} - ${safeChannel}.m4a`;
      session = {
        status: 'pending',
        audioFormat,
        tempDir,
        tempAudioFile: join(tempDir, 'audio.m4a'),
        finalFilename,
        finalFilePath: join(tempDir, finalFilename),
        audioTasks,
        videoTasks: [],
        isAudioOnly: true,
        createdAt: Date.now(),
        cleanupTimeoutId: null
      };
      responsePayload = {
        status: "ok",
        videoId,
        title,
        quality: `${Math.round((audioFormat.bitrate || 0) / 1000)}kbps AAC`,
        channel,
        thumbnail: info.basic_info?.thumbnail?.[0].url,
        filename: session.finalFilename,
        expiration: formatDuration(EXPIRATION_SECONDS)
      };
    } else {
      const suitableVideos = info.streaming_data.adaptive_formats.filter(f => f.has_video && !f.has_audio && f.mime_type?.includes('avc1') && f.height && f.height <= cappedQuality).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0)) as YTFormat[];
      if (suitableVideos.length === 0) throw new Error(`No suitable H.264 video stream found for ${cappedQuality}p.`);
      const videoFormat = suitableVideos[0];
      if (!videoFormat.content_length) throw new Error('Selected video format is missing size info.');

      videoFormat.deciphered_url = await videoFormat.decipher();
      if (!videoFormat.deciphered_url) throw new Error("Failed to decipher video URL.");

      const videoTasks: DownloadTask[] = [];
      for (let i = 0, start = 0; start < videoFormat.content_length; i++) {
        const end = Math.min(start + targetChunkSizeBytes - 1, videoFormat.content_length - 1);
        videoTasks.push({
          index: i,
          format: videoFormat,
          start,
          end,
          retries: 3,
          description: `Video Chunk ${i + 1}`
        });
        start = end + 1;
      }

      const finalFilename = `${safeTitle} - ${safeChannel} (${videoFormat.quality_label}, h264).mp4`;
      session = {
        status: 'pending',
        videoFormat,
        audioFormat,
        tempDir,
        tempVideoFile: join(tempDir, 'video.mp4'),
        tempAudioFile: join(tempDir, 'audio.m4a'),
        finalFilename,
        finalFilePath: join(tempDir, finalFilename),
        videoTasks,
        audioTasks,
        isAudioOnly: false,
        createdAt: Date.now(),
        cleanupTimeoutId: null
      };
      responsePayload = {
        status: "ok",
        videoId,
        title,
        quality: `${session.videoFormat?.quality_label}`,
        channel,
        thumbnail: info.basic_info?.thumbnail?.[0].url,
        filename: session.finalFilename,
        expiration: formatDuration(EXPIRATION_SECONDS)
      };
    }

    downloadSessions.set(sessionId, session);
    scheduleSessionCleanup(sessionId, EXPIRATION_SECONDS * 1000);

    infoCache.set(cacheKey, {
      timestamp: Date.now(),
      data: {
        sessionData: session,
        responseData: responsePayload
      }
    });

    return {
      ...responsePayload,
      cached: false,
      downloadLink: `${requestUrl.protocol}//${requestUrl.host}/stream/${isAudioRequest ? 'audio' : 'video'}/${sessionId}`
    };
  }, {
    query: t.Object({
      url: t.String(),
      quality: t.Optional(t.String()),
      format: t.Optional(t.String())
    })
  })
  .listen({ port: PORT, idleTimeout: BUN_IDLE_TIMEOUT });

console.log(`🦊 Elysia API running at http://localhost:${app.server?.port}`);