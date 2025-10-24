import { Elysia, t } from 'elysia';
import { Innertube } from 'youtubei.js';
import ffmpeg from 'ffmpeg-static';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// --- Imports for Social Handlers ---
import instaHandler from './api/insta';
import fbHandler from './api/fb';
import ttHandler from './api/tt';
import xHandler from './api/x';
import instav2Handler from './api/instav2';
// Assuming api/pin.ts now exports these new functions
import pinHandler, { searchPinterest, getCacheStats, clearCaches } from './api/pin';
// Assuming a new utils file for helper functions like getClientId
import { getClientId } from './api/utils';


const PORT = 3040;
const BUN_IDLE_TIMEOUT = 255;
const EXPIRATION_SECONDS = 180;
const MAX_CONCURRENT_DOWNLOADS = 16;
const DOWNLOAD_CHUNK_SIZE_MB = 10;
const COOKIE_FILE_PATH = 'cookies.txt';
const CACHE_EXPIRATION_MS = 3 * 60 * 1000;

// --- YouTube-Specific Types & Logic ---

type YTFormat = NonNullable<Awaited<ReturnType<Innertube['getBasicInfo']>>['streaming_data']>['formats'][number] & { content_length: number, is_original?: boolean, deciphered_url?: string };
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
        console.warn(`🔴 WARNING: Cookie file not found at '${cookieFilePath}'`);
        return '';
    }
    try {
        const content = await cookieFile.text();
        console.log(`✅ Cookies loaded from ${cookieFilePath}`);
        return content;
    } catch (err) {
        console.error('Error reading cookies:', err);
        return '';
    }
}

function getVideoId(url: string): string | null {
    try {
        const u = new URL(url);
        const hostname = u.hostname;
        const pathname = u.pathname;
        if (hostname.includes('youtube.com')) {
            if (pathname === '/watch') return u.searchParams.get('v');
            const match = pathname.match(/^\/(shorts|live|embed)\/([a-zA-Z0-9_-]{11})/);
            if (match) return match[2];
        }
        if (hostname.includes('youtu.be')) return pathname.substring(1);
    } catch (e) { }
    return null;
}

const formatBytes = (bytes: number, decimals = 2) => !bytes ? '0 Bytes' : `${parseFloat((bytes / Math.pow(1024, Math.floor(Math.log(bytes) / Math.log(1024)))).toFixed(decimals))} ${['Bytes', 'KiB', 'MiB', 'GiB'][Math.floor(Math.log(bytes) / Math.log(1024))]}`;
const formatDuration = (s: number) => (m => s < 60 ? `${Math.floor(s)} second${s > 1 ? 's' : ''}` : `${m} minute${m > 1 ? 's' : ''}`)(Math.floor(s / 60));

async function downloadAndCombineManager(sessionId: string, tasks: DownloadTask[], destinationFile: string) {
    const startTime = performance.now();
    const totalSize = tasks.reduce((sum, t) => sum + (t.end - t.start + 1), 0);
    const actualWorkers = Math.min(tasks.length, MAX_CONCURRENT_DOWNLOADS);
    console.log(`[${sessionId}] Starting combined download of ${tasks.length} chunks for ${destinationFile.split('/').pop()}... (Using ${actualWorkers} workers)`);

    const downloadedChunks = new Map<number, Buffer>();
    let chunksWritten = 0;
    const writer = Bun.file(destinationFile).writer();

    const processTask = async (task: DownloadTask, workerId: number) => {
        const url = task.format.deciphered_url;
        if (!url) throw new Error(`Task ${task.description} missing deciphered URL.`);
        for (let attempt = 0; attempt <= task.retries; attempt++) {
            try {
                const resp = await fetch(url, { headers: { 'Range': `bytes=${task.start}-${task.end}` } });
                if (!resp.ok) throw new Error(`Fetch failed with status ${resp.status}`);
                const buf = Buffer.from(await resp.arrayBuffer());
                downloadedChunks.set(task.index, buf);
                while (downloadedChunks.has(chunksWritten)) {
                    writer.write(downloadedChunks.get(chunksWritten)!);
                    downloadedChunks.delete(chunksWritten);
                    chunksWritten++;
                }
                return;
            } catch (e) {
                console.error(`[${sessionId}] Worker ${workerId} FAILED task ${task.description} attempt ${attempt + 1}`);
                if (attempt < task.retries) await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
                else throw new Error(`Task ${task.description} failed permanently.`);
            }
        }
    };

    const tasksToProcess = [...tasks];
    await Promise.all(Array.from({ length: actualWorkers }, (_, i) => (async () => {
        while (tasksToProcess.length > 0) {
            const task = tasksToProcess.shift();
            if (task) await processTask(task, i + 1);
        }
    })()));

    await writer.end();
    const durationSec = (performance.now() - startTime) / 1000;
    console.log(`[${sessionId}] Download & Combine Complete: ${formatBytes(totalSize)} in ${durationSec.toFixed(2)}s (${formatBytes(durationSec > 0 ? totalSize / durationSec : 0)}/s)`);
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
        } catch (err: any) {
            if (err.code !== 'ENOENT') console.error(`[${sessionId}] Final cleanup error:`, err);
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

// --- Elysia App Setup ---

const app = new Elysia()
    .onStart(async () => {
        yt = await Innertube.create({ cookie: await getCookieFileContent(COOKIE_FILE_PATH) });
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

    // --- New Routes ---

    .get('/', () => new Response(Bun.file('public/home.html')))
    .get('/robots.txt', () => new Response(['User-agent: *', 'Disallow: /'].join('\n'), { headers: { 'Content-Type': 'text/plain' } }))
    
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
      const clientId = getClientId(request); // Assumes getClientId is imported
      if (search) {
        const searchLimit = limit ? Math.min(parseInt(limit), 50) : 20;
        const result = await searchPinterest(search as string, clientId, searchLimit); // Assumes searchPinterest is imported
        if (result.status === 'rate_limited') {
          set.status = 429;
          set.headers['Retry-After'] = '60';
        }
        return result;
      } else if (url) {
        const result = await pinHandler(url as string, clientId); // Assumes pinHandler is imported
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
    
    .get('/pin/stats', () => getCacheStats()) // Assumes getCacheStats is imported
    
    .post('/pin/cache/clear', () => {
      clearCaches(); // Assumes clearCaches is imported
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
          console.log(`[${videoId}] Cache HIT for key: ${cacheKey}`);
          const getInfoStart = performance.now();
          const { sessionData, responseData } = cachedItem.data;
          const newSessionId = Bun.randomUUIDv7();
          const tempDir = join(process.cwd(), 'temp', newSessionId);
          const newSession: DownloadSession = {
              ...sessionData,
              tempDir,
              tempVideoFile: sessionData.tempVideoFile ? join(tempDir, 'video.mp4') : undefined,
              tempAudioFile: join(tempDir, 'audio.m4a'),
              finalFilePath: join(tempDir, sessionData.finalFilename),
              createdAt: Date.now(),
              cleanupTimeoutId: null
          };
          downloadSessions.set(newSessionId, newSession);
          scheduleSessionCleanup(newSessionId, EXPIRATION_SECONDS * 1000);
          const requestUrl = new URL(request.url);
          return {
              ...responseData,
              cached: true,
              infoFetchTime: `${(performance.now() - getInfoStart).toFixed(2)}ms (cached)`,
              downloadLink: `${requestUrl.protocol}//${requestUrl.host}/stream/${isAudioRequest ? 'audio' : 'video'}/${newSessionId}`
          };
      }

      console.log(`[${videoId}] Cache MISS for key: ${cacheKey}`);
      const getInfoStart = performance.now();
      console.log(`[${videoId}] Fetching info using shared session...`);
      
      const info = await yt.getInfo(videoId, {
          client: 'TV',
          player_id: yt.session.player.id
      });

      if (info.playability_status?.status !== 'OK') throw new Error(`Video not playable: ${info.playability_status?.reason}`);
      if (!info.streaming_data) throw new Error('No streaming data found.');

      const title = info.primary_info?.title?.text ?? 'video';
      const channel = info.secondary_info?.owner?.author?.name ?? 'channel';
      
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

      const createTasks = (format: YTFormat, descriptionPrefix: string): DownloadTask[] => {
          const tasks: DownloadTask[] = [];
          const targetChunkSizeBytes = DOWNLOAD_CHUNK_SIZE_MB * 1024 * 1024;
          for (let i = 0, start = 0; start < format.content_length; i++) {
              const end = Math.min(start + targetChunkSizeBytes - 1, format.content_length - 1);
              tasks.push({ index: i, format, start, end, retries: 3, description: `${descriptionPrefix} Chunk ${i + 1}` });
              start = end + 1;
          }
          return tasks;
      };
      const audioTasks = createTasks(audioFormat, 'Audio');
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
          };
      } else {
          const suitableVideos = info.streaming_data.adaptive_formats
              .filter(f => f.has_video && !f.has_audio && f.mime_type?.includes('avc1') && f.height && f.height <= cappedQuality)
              .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0)) as YTFormat[];
          if (suitableVideos.length === 0) throw new Error(`No suitable H.264 video stream found for ${cappedQuality}p.`);
          const videoFormat = suitableVideos[0];

          if (!videoFormat.content_length) throw new Error('Selected video format is missing size info.');
          videoFormat.deciphered_url = videoFormat.decipher(yt.session.player);
          if (!videoFormat.deciphered_url) throw new Error("Failed to decipher video URL.");
          console.log(`[${videoId}] ✅ Video URL deciphered.`);

          const videoTasks = createTasks(videoFormat, 'Video');
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
          };
      }

      downloadSessions.set(sessionId, session);
      scheduleSessionCleanup(sessionId, EXPIRATION_SECONDS * 1000);
      const fullResponse = {
          ...responsePayload,
          expiration: formatDuration(EXPIRATION_SECONDS),
          infoFetchTime: `${(performance.now() - getInfoStart).toFixed(2)}ms`
      };
      infoCache.set(cacheKey, { timestamp: Date.now(), data: { sessionData: session, responseData: fullResponse } });
      return { ...fullResponse, cached: false, downloadLink: `${requestUrl.protocol}//${requestUrl.host}/stream/${isAudioRequest ? 'audio' : 'video'}/${sessionId}` };

    }, { query: t.Object({ url: t.String(), quality: t.Optional(t.String()), format: t.Optional(t.String()) }) })

    // --- YouTube Stream/Download Route ---
    .group('/stream', app => app
        .get('/:type/:id', async ({ params, set }) => {
            const { id: sessionId, type } = params;
            const session = downloadSessions.get(sessionId);
            const isAudio = type === 'audio';
            if (!session || session.isAudioOnly !== isAudio) {
                set.status = 404;
                return { status: 'error', message: 'Session not found or invalid type.' };
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
                return new Response(finalFile.stream(), { headers: { 'Content-Type': `${type}/mp4`, 'Content-Length': finalFile.size.toString() } });
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

                    const downloadPromises = [downloadAndCombineManager(sessionId, session.audioTasks, session.tempAudioFile)];
                    if (!isAudio) downloadPromises.push(downloadAndCombineManager(sessionId, session.videoTasks, session.tempVideoFile!));
                    await Promise.all(downloadPromises);

                    session.status = 'merging';
                    if (!ffmpeg) throw new Error("FFmpeg path is not available.");
                    const ffmpegStart = performance.now();

                    const ffmpegArgs = isAudio ?
                        [ffmpeg, '-i', session.tempAudioFile, '-c', 'copy', '-y', session.finalFilePath] :
                        [ffmpeg, '-i', session.tempVideoFile!, '-i', session.tempAudioFile, '-c', 'copy', '-movflags', '+faststart', '-y', session.finalFilePath];
                    const ffmpegProcess = Bun.spawn(ffmpegArgs, { stderr: 'pipe' });
                    if ((await ffmpegProcess.exited) !== 0) throw new Error(`FFmpeg failed. STDERR: ${await new Response(ffmpegProcess.stderr).text()}`);
                    console.log(`[${sessionId}] FFmpeg ${isAudio ? 'remux' : 'merge'} successful in ${(performance.now() - ffmpegStart).toFixed(2)}ms.`);

                    session.status = 'completed';
                    if (!isAudio) await Bun.file(session.tempVideoFile!).delete();
                    await Bun.file(session.tempAudioFile).delete();
                    const finalFile = Bun.file(session.finalFilePath);
                    set.headers['Content-Disposition'] = `attachment; filename="${session.finalFilename}"`;
                    return new Response(finalFile.stream(), { headers: { 'Content-Type': `${type}/mp4`, 'Content-Length': finalFile.size.toString() } });
                } catch (error: any) {
                    session.status = 'error';
                    session.error = error.message;
                    scheduleSessionCleanup(sessionId, 5000);
                    set.status = 500;
                    return { status: 'error', message: `Failed to process stream: ${error.message}` };
                }
            }
        }, { params: t.Object({ id: t.String(), type: t.String() }) })
    )
    
    // --- Start Server ---
    .listen({ port: PORT, idleTimeout: BUN_IDLE_TIMEOUT });

console.log(`🦊 Elysia API running at http://localhost:${app.server?.port}`);