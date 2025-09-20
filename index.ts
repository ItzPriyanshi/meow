import { Elysia, t } from 'elysia';
import { Innertube } from 'youtubei.js';
import ffmpeg from 'ffmpeg-static';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import instaHandler from './api/insta';
import fbHandler from './api/fb';
import pinHandler from './api/pin';
import xHandler from './api/x';

const PORT = 3040;
const BUN_IDLE_TIMEOUT = 255;
const EXPIRATION_SECONDS = 180;
const MAX_CONCURRENT_DOWNLOADS = 16;
const DOWNLOAD_CHUNK_SIZE_MB = 10;
const COOKIE_FILE_PATH = 'cookies.txt';
const CACHE_EXPIRATION_MS = 3 * 60 * 1000;

type YTFormat = NonNullable<Awaited<ReturnType<Innertube['getBasicInfo']>>['streaming_data']>['formats'][number] & { content_length: number, is_original?: boolean, deciphered_url?: string };
interface DownloadTask { index: number; format: YTFormat; start: number; end: number; description: string; retries: number; }
interface DownloadSession { status: 'pending' | 'downloading' | 'merging' | 'completed' | 'error'; videoFormat?: YTFormat; audioFormat: YTFormat; tempDir: string; tempVideoFile?: string; tempAudioFile: string; finalFilename: string; finalFilePath: string; videoTasks: DownloadTask[]; audioTasks: DownloadTask[]; error?: string; isAudioOnly: boolean; createdAt: number; cleanupTimeoutId: NodeJS.Timeout | null; }
interface CacheEntry { timestamp: number; data: any; }

const downloadSessions = new Map<string, DownloadSession>();
const infoCache = new Map<string, CacheEntry>();
let yt: Innertube;

async function getCookieFileContent(cookieFilePath: string): Promise<string> {
  const cookieFile = Bun.file(cookieFilePath);
  if (!(await cookieFile.exists())) { console.warn(`🔴 WARNING: Cookie file not found at '${cookieFilePath}'. Running unauthenticated.`); return ''; }
  try { const cookieFileContent = await cookieFile.text(); console.log(`✅ Cookies loaded successfully from ${cookieFilePath}.`); return cookieFileContent; } 
  catch (error) { console.error('CRITICAL: Error reading cookie file:', error); return ''; }
}

function getVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes('youtube.com')) {
      if (urlObj.pathname === '/watch') return urlObj.searchParams.get('v');
      const shortsMatch = urlObj.pathname.match(/^\/(shorts|live|embed)\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[2];
    }
    if (urlObj.hostname.includes('youtu.be')) return urlObj.pathname.split('/')[1];
  } catch (e) {}
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
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  }
  const seconds = Math.floor(totalSeconds);
  return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

async function downloadAndCombineManager(sessionId: string, tasks: DownloadTask[], destinationFile: string) {
  const startTime = performance.now();
  const totalSize = tasks.reduce((sum, task) => sum + (task.end - task.start + 1), 0);
  const actualWorkers = Math.min(tasks.length, MAX_CONCURRENT_DOWNLOADS);
  console.log(`[${sessionId}] Starting combined download of ${tasks.length} chunks for ${destinationFile.split('/').pop()}... (Using ${actualWorkers} workers)`);
  const downloadedChunks = new Map<number, Buffer>();
  let chunksWritten = 0;
  const writer = Bun.file(destinationFile).writer();
  const processTask = async (task: DownloadTask, workerId: number): Promise<void> => {
    let attempt = 0;
    const url = task.format.deciphered_url;
    if (!url) throw new Error(`Task ${task.description} is missing a deciphered URL.`);
    while (attempt <= task.retries) {
      try {
        const response = await fetch(url, { headers: { 'Range': `bytes=${task.start}-${task.end}` } });
        if (!response.ok) throw new Error(`Fetch failed with status ${response.status} ${response.statusText}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        downloadedChunks.set(task.index, buffer);
        while (downloadedChunks.has(chunksWritten)) {
          writer.write(downloadedChunks.get(chunksWritten)!);
          downloadedChunks.delete(chunksWritten);
          chunksWritten++;
        }
        return;
      } catch (error) {
        console.error(`\n[${sessionId}] Worker ${workerId} FAILED task ${task.description} (attempt ${attempt + 1}/${task.retries + 1}).`);
        if (attempt < task.retries) {
          attempt++;
          await new Promise(resolve => setTimeout(resolve, 250 * attempt));
        } else {
          throw new Error(`Task ${task.description} failed permanently.`);
        }
      }
    }
  };
  const tasksToProcess = [...tasks];
  const workerPromises = Array.from({ length: actualWorkers }, (_, i) => {
    const workerId = i + 1;
    return (async () => {
      while (tasksToProcess.length > 0) {
        const task = tasksToProcess.shift();
        if (task) await processTask(task, workerId);
      }
    })();
  });
  await Promise.all(workerPromises);
  await writer.end();
  const endTime = performance.now();
  const durationSec = (endTime - startTime) / 1000;
  const speed = durationSec > 0 ? totalSize / durationSec : 0;
  console.log(`[${sessionId}] Download & Combine Complete: ${formatBytes(totalSize)} in ${durationSec.toFixed(2)}s (${formatBytes(speed)}/s)`);
}

async function cleanupSession(sessionId: string) {
  const session = downloadSessions.get(sessionId);
  if (session) {
    console.log(`[${sessionId}] Cleaning up session...`);
    if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);
    downloadSessions.delete(sessionId);
    try {
      await rmdir(session.tempDir, { recursive: true });
      console.log(`[${sessionId}] Removed temp dir: ${session.tempDir}`);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code !== 'ENOENT') {
        console.error(`[${sessionId}] Final cleanup error:`, err);
      }
    }
  }
}

function scheduleSessionCleanup(sessionId: string, delayMs: number) {
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);
  session.cleanupTimeoutId = setTimeout(() => {
    console.log(`[${sessionId}] Session expired after ${formatDuration(delayMs / 1000)}. Cleaning up.`);
    cleanupSession(sessionId);
  }, delayMs);
}

const app = new Elysia()
  .onStart(async () => {
    const cookieFileContent = await getCookieFileContent(COOKIE_FILE_PATH);
    yt = await Innertube.create({ cookie: cookieFileContent });
    console.log("✅ Innertube ready with shared session.");
  })
  .onAfterHandle(({ response, set }) => {
    if (typeof response === 'object' && response !== null && !(response instanceof Response)) {
      set.headers['Content-Type'] = 'application/json;charset=utf-8';
      return JSON.stringify(response, null, 2);
    }
    return response;
  })
  .onError(({ code, error, set }) => {
    console.error(`Error [${code}]: ${error.toString()}`);
    set.status = code === 'VALIDATION' ? 400 : 500;
    return { status: 'error', message: error.toString() };
  })
  .get('/robots.txt', () => new Response(['User-agent: *', 'Disallow: /'].join('\n'), { headers: { 'Content-Type': 'text/plain' } }))
  .get('/', async ({ query, request }) => {
    const { url: videoUrl, quality, format } = query;
    const isAudioRequest = format === 'm4a';
    const videoId = getVideoId(videoUrl);
    if (!videoId) throw new Error("Invalid YouTube URL.");
    const cappedQuality = Math.min(parseInt(quality || '1080'), 1080);
    const cacheKey = isAudioRequest ? `${videoId}-audio` : `${videoId}-video-${cappedQuality}p`;
    const cachedItem = infoCache.get(cacheKey);
    if (cachedItem && (Date.now() - cachedItem.timestamp < CACHE_EXPIRATION_MS)) {
      console.log(`[${videoId}] Cache HIT for key: ${cacheKey}`);
      const getInfoStart = performance.now();
      const { sessionData, responseData } = cachedItem.data;
      const newSessionId = Bun.randomUUIDv7();
      const tempDir = join(process.cwd(), 'temp', newSessionId);
      const newSession: DownloadSession = { ...sessionData, tempDir, tempVideoFile: sessionData.tempVideoFile ? join(tempDir, 'video.mp4') : undefined, tempAudioFile: join(tempDir, 'audio.m4a'), finalFilePath: join(tempDir, sessionData.finalFilename), createdAt: Date.now(), cleanupTimeoutId: null };
      downloadSessions.set(newSessionId, newSession);
      scheduleSessionCleanup(newSessionId, EXPIRATION_SECONDS * 1000);
      const requestUrl = new URL(request.url);
      return { ...responseData, cached: true, infoFetchTime: `${(performance.now() - getInfoStart).toFixed(2)}ms (cached)`, downloadLink: `${requestUrl.protocol}//${requestUrl.host}/stream/${isAudioRequest ? 'audio' : 'video'}/${newSessionId}` };
    }
    console.log(`[${videoId}] Cache MISS for key: ${cacheKey}`);
    const getInfoStart = performance.now();
    console.log(`[${videoId}] Fetching info using shared session...`);
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
    audioFormat.deciphered_url = audioFormat.decipher(yt.session.player);
    if (!audioFormat.deciphered_url) throw new Error("Failed to decipher audio URL.");
    console.log(`[${videoId}] ✅ Audio URL deciphered.`);
    const sessionId = Bun.randomUUIDv7();
    const tempDir = join(process.cwd(), 'temp', sessionId);
    const audioTasks: DownloadTask[] = [];
    const targetChunkSizeBytes = DOWNLOAD_CHUNK_SIZE_MB * 1024 * 1024;
    for (let i = 0, start = 0; start < audioFormat.content_length; i++) {
      const end = Math.min(start + targetChunkSizeBytes - 1, audioFormat.content_length - 1);
      audioTasks.push({ index: i, format: audioFormat, start, end, retries: 3, description: `Audio Chunk ${i + 1}` });
      start = end + 1;
    }
    let session: DownloadSession;
    let responsePayload: any;
    const requestUrl = new URL(request.url);
    if (isAudioRequest) {
      const finalFilename = `${safeTitle} - ${safeChannel}.m4a`;
      session = { status: 'pending', audioFormat, tempDir, tempAudioFile: join(tempDir, 'audio.m4a'), finalFilename, finalFilePath: join(tempDir, finalFilename), audioTasks, videoTasks: [], isAudioOnly: true, createdAt: Date.now(), cleanupTimeoutId: null };
      responsePayload = { status: "ok", videoId, title, quality: `${Math.round((audioFormat.bitrate || 0) / 1000)}kbps AAC`, channel, thumbnail: info.basic_info?.thumbnail?.[0].url, filename: session.finalFilename, expiration: formatDuration(EXPIRATION_SECONDS), infoFetchTime: `${(performance.now() - getInfoStart).toFixed(2)}ms` };
    } else {
      const suitableVideos = info.streaming_data.adaptive_formats.filter(f => f.has_video && !f.has_audio && f.mime_type?.includes('avc1') && f.height && f.height <= cappedQuality).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0)) as YTFormat[];
      if (suitableVideos.length === 0) throw new Error(`No suitable H.264 video stream found for ${cappedQuality}p.`);
      const videoFormat = suitableVideos[0];
      if (!videoFormat.content_length) throw new Error('Selected video format is missing size info.');
      videoFormat.deciphered_url = videoFormat.decipher(yt.session.player);
      if (!videoFormat.deciphered_url) throw new Error("Failed to decipher video URL.");
      console.log(`[${videoId}] ✅ Video URL deciphered.`);
      const videoTasks: DownloadTask[] = [];
      for (let i = 0, start = 0; start < videoFormat.content_length; i++) {
        const end = Math.min(start + targetChunkSizeBytes - 1, videoFormat.content_length - 1);
        videoTasks.push({ index: i, format: videoFormat, start, end, retries: 3, description: `Video Chunk ${i + 1}` });
        start = end + 1;
      }
      const finalFilename = `${safeTitle} - ${safeChannel} (${videoFormat.quality_label}, h264).mp4`;
      session = { status: 'pending', videoFormat, audioFormat, tempDir, tempVideoFile: join(tempDir, 'video.mp4'), tempAudioFile: join(tempDir, 'audio.m4a'), finalFilename, finalFilePath: join(tempDir, finalFilename), videoTasks, audioTasks, isAudioOnly: false, createdAt: Date.now(), cleanupTimeoutId: null };
      responsePayload = { status: "ok", videoId, title, quality: `${session.videoFormat?.quality_label}`, channel, thumbnail: info.basic_info?.thumbnail?.[0].url, filename: session.finalFilename, expiration: formatDuration(EXPIRATION_SECONDS), infoFetchTime: `${(performance.now() - getInfoStart).toFixed(2)}ms` };
    }
    downloadSessions.set(sessionId, session);
    scheduleSessionCleanup(sessionId, EXPIRATION_SECONDS * 1000);
    infoCache.set(cacheKey, { timestamp: Date.now(), data: { sessionData: session, responseData: responsePayload } });
    return { ...responsePayload, cached: false, downloadLink: `${requestUrl.protocol}//${requestUrl.host}/stream/${isAudioRequest ? 'audio' : 'video'}/${sessionId}` };
  }, { query: t.Object({ url: t.String(), quality: t.Optional(t.String()), format: t.Optional(t.String()) }) })
  .get('/stream/video/:id', async ({ params, set }) => {
    const { id: sessionId } = params;
    const session = downloadSessions.get(sessionId);
    if (!session || session.isAudioOnly) {
      set.status = 404;
      return { status: 'error', message: 'Session not found or is audio-only.' };
    }
    if (session.status === 'error') {
      set.status = 500;
      return { status: 'error', message: `Session failed: ${session.error}` };
    }
    scheduleSessionCleanup(sessionId, EXPIRATION_SECONDS * 1000);
    if (session.status === 'completed') {
      const finalFile = Bun.file(session.finalFilePath);
      if (!(await finalFile.exists())) {
        await cleanupSession(sessionId);
        set.status = 410;
        return { status: 'error', message: "File expired and was cleaned up." };
      }
      set.headers['Content-Disposition'] = `attachment; filename="${session.finalFilename}"`;
      return new Response(finalFile.stream(), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': finalFile.size.toString() } });
    }
    if (session.status === 'downloading' || session.status === 'merging') {
      set.status = 202;
      return { status: 'processing', message: 'Download is in progress.' };
    }
    if (session.status === 'pending') {
      try {
        await mkdir(session.tempDir, { recursive: true });
        if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);
        session.status = 'downloading';
        await Promise.all([
          downloadAndCombineManager(sessionId, session.videoTasks, session.tempVideoFile!),
          downloadAndCombineManager(sessionId, session.audioTasks, session.tempAudioFile),
        ]);
        session.status = 'merging';
        if (!ffmpeg) throw new Error("FFmpeg path is not available.");
        const ffmpegStart = performance.now();
        const ffmpegArgs = [ffmpeg, '-i', session.tempVideoFile!, '-i', session.tempAudioFile, '-c', 'copy', '-movflags', '+faststart', '-y', session.finalFilePath];
        const ffmpegProcess = Bun.spawn(ffmpegArgs, { stderr: 'pipe' });
        if ((await ffmpegProcess.exited) !== 0) throw new Error(`FFmpeg failed. STDERR: ${await new Response(ffmpegProcess.stderr).text()}`);
        console.log(`[${sessionId}] FFmpeg merge successful in ${(performance.now() - ffmpegStart).toFixed(2)}ms.`);
        session.status = 'completed';
        await Bun.file(session.tempVideoFile!).delete();
        await Bun.file(session.tempAudioFile).delete();
        const finalFile = Bun.file(session.finalFilePath);
        set.headers['Content-Disposition'] = `attachment; filename="${session.finalFilename}"`;
        return new Response(finalFile.stream(), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': finalFile.size.toString() } });
      } catch (error: any) {
        session.status = 'error';
        session.error = error.message;
        scheduleSessionCleanup(sessionId, 5000);
        set.status = 500;
        return { status: 'error', message: `Failed to process stream: ${error.message}` };
      }
    }
  }, { params: t.Object({ id: t.String() }) })
  .get('/stream/audio/:id', async ({ params, set }) => {
    const { id: sessionId } = params;
    const session = downloadSessions.get(sessionId);
    if (!session || !session.isAudioOnly) {
      set.status = 404;
      return { status: 'error', message: 'Session not found or is not audio-only.' };
    }
    if (session.status === 'error') {
      set.status = 500;
      return { status: 'error', message: `Session failed: ${session.error}` };
    }
    scheduleSessionCleanup(sessionId, EXPIRATION_SECONDS * 1000);
    if (session.status === 'completed') {
      const finalFile = Bun.file(session.finalFilePath);
      if (!(await finalFile.exists())) {
        await cleanupSession(sessionId);
        set.status = 410;
        return { status: 'error', message: "File expired and was cleaned up." };
      }
      set.headers['Content-Disposition'] = `attachment; filename="${session.finalFilename}"`;
      return new Response(finalFile.stream(), { headers: { 'Content-Type': 'audio/mp4', 'Content-Length': finalFile.size.toString() } });
    }
    if (session.status === 'downloading' || session.status === 'merging') {
      set.status = 202;
      return { status: 'processing', message: 'Download is in progress.' };
    }
    if (session.status === 'pending') {
      try {
        await mkdir(session.tempDir, { recursive: true });
        if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);
        session.status = 'downloading';
        await downloadAndCombineManager(sessionId, session.audioTasks, session.tempAudioFile);
        session.status = 'merging';
        const ffmpegStart = performance.now();
        if (!ffmpeg) {
          throw new Error("FFmpeg path is not available.");
        }
        const ffmpegArgs = [ffmpeg, '-i', session.tempAudioFile, '-c', 'copy', '-y', session.finalFilePath];
        const ffmpegProcess = Bun.spawn(ffmpegArgs, { stderr: 'pipe' });
        if ((await ffmpegProcess.exited) !== 0) throw new Error(`FFmpeg failed during remux. STDERR: ${await new Response(ffmpegProcess.stderr).text()}`);
        console.log(`[${sessionId}] FFmpeg remux successful in ${(performance.now() - ffmpegStart).toFixed(2)}ms.`);
        session.status = 'completed';
        await Bun.file(session.tempAudioFile).delete();
        const finalFile = Bun.file(session.finalFilePath);
        set.headers['Content-Disposition'] = `attachment; filename="${session.finalFilename}"`;
        return new Response(finalFile.stream(), { headers: { 'Content-Type': 'audio/mp4', 'Content-Length': finalFile.size.toString() } });
      } catch (error: any) {
        session.status = 'error';
        session.error = error.message;
        scheduleSessionCleanup(sessionId, 5000);
        set.status = 500;
        return { status: 'error', message: `Failed to process stream: ${error.message}` };
      }
    }
  }, { params: t.Object({ id: t.String() }) })
  .get('/insta', async ({ query }) => {
    const { url } = query;
    if (!url) throw new Error('Missing URL');
    return await instaHandler(url);
  }, { query: t.Object({ url: t.String() }) })
  .get('/fb', async ({ query }) => {
    const { url } = query;
    if (!url) throw new Error('Missing URL');
    return await fbHandler(url);
  }, { query: t.Object({ url: t.String() }) })
  .get('/pin', async ({ query }) => {
    const { url } = query;
    if (!url) throw new Error('Missing URL');
    return await pinHandler(url);
  }, { query: t.Object({ url: t.String() }) })
  .get('/x', async ({ query }) => {
    const { url } = query;
    if (!url) throw new Error('Missing URL');
    return await xHandler(url);
  }, { query: t.Object({ url: t.String() }) })
  .listen({ port: PORT, idleTimeout: BUN_IDLE_TIMEOUT });
console.log(`🦊 Elysia YouTube API running at http://localhost:${app.server?.port}`);
