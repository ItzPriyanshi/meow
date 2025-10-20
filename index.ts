import { Elysia, t } from 'elysia';
import { staticPlugin } from '@elysiajs/static';
import { Innertube, Platform, Types, UniversalCache, type YTNodes } from 'youtubei.js/web';
import ffmpeg from 'ffmpeg-static';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import instaHandler from './api/insta';
import instav2Handler from './api/instav2';
import fbHandler from './api/fb';
import pinHandler, { searchPinterest, getCacheStats, clearCaches } from './api/pin';
import ttHandler from './api/tt';
import xHandler from './api/x';

Platform.shim.eval = async (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
  const properties = [];
  if(env.n) {
    properties.push(`n: exportedVars.nFunction("${env.n}")`)
  }
  if (env.sig) {
    properties.push(`sig: exportedVars.sigFunction("${env.sig}")`)
  }
  const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
  return new Function(code)();
}

const PORT = 3040;
const BUN_IDLE_TIMEOUT = 255;
const EXPIRATION_SECONDS = 180;
const MAX_CONCURRENT_DOWNLOADS = 16;
const DOWNLOAD_CHUNK_SIZE_MB = 10;
const COOKIE_FILE_PATH = 'cookies.txt';
const CACHE_EXPIRATION_MS = 3 * 60 * 1000;

function getClientId(request: Request): string {
    return request.headers.get('cf-connecting-ip') ||
           request.headers.get('x-real-ip') ||
           request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
           'unknown';
}

type YTFormat = YTNodes.Format & { content_length: number, deciphered_url?: string };

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
        if (u.hostname.includes('youtube.com')) {
            if (u.pathname === '/watch') return u.searchParams.get('v');
            const m = u.pathname.match(/^\/(shorts|live|embed)\/([a-zA-Z0-9_-]{11})/);
            if (m) return m[2];
        }
        if (u.hostname.includes('youtu.be')) return u.pathname.split('/')[1];
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
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    if (m > 0) return `${m} minute${m > 1 ? 's' : ''}`;
    return `${s} second${s > 1 ? 's' : ''}`;
}

async function downloadAndCombineManager(sessionId: string, tasks: DownloadTask[], destinationFile: string) {
    const startTime = performance.now();
    const totalSize = tasks.reduce((sum, t) => sum + (t.end - t.start + 1), 0);
    const actualWorkers = Math.min(tasks.length, MAX_CONCURRENT_DOWNLOADS);
    console.log(`[${sessionId}] Starting download of ${tasks.length} chunks for ${destinationFile.split('/').pop()}... (${actualWorkers} workers)`);
    
    const downloadedChunks = new Map<number, Buffer>();
    let chunksWritten = 0;
    const writer = Bun.file(destinationFile).writer();
    
    const processTask = async (task: DownloadTask) => {
        const url = task.format.deciphered_url;
        if (!url) throw new Error(`Task ${task.description} is missing a deciphered URL.`);
        for (let attempt = 0; attempt <= task.retries; attempt++) {
            try {
                const resp = await fetch(url, { headers: { 'Range': `bytes=${task.start}-${task.end}` } });
                if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
                const buf = Buffer.from(await resp.arrayBuffer());
                downloadedChunks.set(task.index, buf);
                while (downloadedChunks.has(chunksWritten)) {
                    writer.write(downloadedChunks.get(chunksWritten)!);
                    downloadedChunks.delete(chunksWritten);
                    chunksWritten++;
                }
                return;
            } catch (e) {
                console.error(`[${sessionId}] FAILED task ${task.description} attempt ${attempt + 1}`);
                if (attempt >= task.retries) throw new Error(`Task ${task.description} failed permanently.`);
                await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
            }
        }
    };

    const tasksToProcess = [...tasks];
    const workerPromises = Array.from({ length: actualWorkers }, () => (async () => {
        while (tasksToProcess.length > 0) {
            const task = tasksToProcess.shift();
            if (task) await processTask(task);
        }
    })());

    await Promise.all(workerPromises);
    await writer.end();

    const durationSec = (performance.now() - startTime) / 1000;
    const speed = durationSec > 0 ? totalSize / durationSec : 0;
    console.log(`[${sessionId}] Download Complete: ${formatBytes(totalSize)} in ${durationSec.toFixed(2)}s (${formatBytes(speed)}/s)`);
}

async function cleanupSession(sessionId: string) {
    const session = downloadSessions.get(sessionId);
    if (session) {
        console.log(`[${sessionId}] Cleaning up session...`);
        if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);
        downloadSessions.delete(sessionId);
        try {
            await rm(session.tempDir, { recursive: true, force: true });
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

const app = new Elysia()
    .use(staticPlugin({ assets: 'public', prefix: '' }))
    .onStart(async () => {
        await mkdir(join(process.cwd(), 'temp'), { recursive: true });
        const cookie = await getCookieFileContent(COOKIE_FILE_PATH);
        yt = await Innertube.create({ cookie, cache: new UniversalCache(true), player_id: '0004de42' });
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
    .get('/', () => Bun.file('public/home.html'))
    .get('/robots.txt', () => new Response('User-agent: *\nDisallow: /', { headers: { 'Content-Type': 'text/plain' } }))

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
            const newSessionId = crypto.randomUUID();
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
        const info = await yt.getInfo(videoId, { client: 'TV' });

        if (info.playability_status?.status !== 'OK') throw new Error(`Video not playable: ${info.playability_status?.reason}`);
        if (!info.streaming_data) throw new Error('No streaming data found.');

        const title = info.basic_info.title || 'video';
        const channel = info.basic_info.author || 'channel';
        const safeTitle = title.replace(/[^a-zA-Z0-9 ._-]/g, '').trim();
        const safeChannel = channel.replace(/[^a-zA-Z0-9 ._-]/g, '').trim();

        const allM4aAudio = info.streaming_data.adaptive_formats.filter(f => f.has_audio && !f.has_video && f.mime_type.includes('mp4a')) as YTFormat[];
        if (allM4aAudio.length === 0) throw new Error('No AAC (.m4a) audio track found.');
        const audioFormat = allM4aAudio.sort((a, b) => b.bitrate - a.bitrate)[0];
        if (!audioFormat.content_length) throw new Error('Selected audio format is missing size info.');

        audioFormat.deciphered_url = await audioFormat.decipher();
        if (!audioFormat.deciphered_url) throw new Error("Failed to decipher audio URL.");
        console.log(`[${videoId}] ✅ Audio URL deciphered.`);

        const sessionId = crypto.randomUUID();
        const tempDir = join(process.cwd(), 'temp', sessionId);
        const audioTasks: DownloadTask[] = [];
        const targetChunkSizeBytes = DOWNLOAD_CHUNK_SIZE_MB * 1024 * 1024;
        for (let i = 0, start = 0; start < audioFormat.content_length; i++, start += targetChunkSizeBytes) {
            const end = Math.min(start + targetChunkSizeBytes - 1, audioFormat.content_length - 1);
            audioTasks.push({ index: i, format: audioFormat, start, end, retries: 3, description: `Audio Chunk ${i + 1}` });
        }

        let session: DownloadSession;
        let responsePayload: any;

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
                status: "ok", videoId, title,
                quality: `${Math.round(audioFormat.bitrate / 1000)}kbps AAC`,
                channel, thumbnail: info.basic_info.thumbnail?.at(0)?.url,
                filename: session.finalFilename, expiration: formatDuration(EXPIRATION_SECONDS),
                infoFetchTime: `${(performance.now() - getInfoStart).toFixed(2)}ms`
            };
        } else {
            const suitableVideos = info.streaming_data.adaptive_formats
                .filter(f => f.has_video && !f.has_audio && f.mime_type.includes('avc1') && f.height <= cappedQuality)
                .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate) as YTFormat[];
            
            if (suitableVideos.length === 0) throw new Error(`No suitable H.264 video stream found for ${cappedQuality}p.`);
            const videoFormat = suitableVideos[0];
            if (!videoFormat.content_length) throw new Error('Selected video format is missing size info.');

            videoFormat.deciphered_url = await videoFormat.decipher();
            if (!videoFormat.deciphered_url) throw new Error("Failed to decipher video URL.");
            console.log(`[${videoId}] ✅ Video URL deciphered.`);

            const videoTasks: DownloadTask[] = [];
            for (let i = 0, start = 0; start < videoFormat.content_length; i++, start += targetChunkSizeBytes) {
                const end = Math.min(start + targetChunkSizeBytes - 1, videoFormat.content_length - 1);
                videoTasks.push({ index: i, format: videoFormat, start, end, retries: 3, description: `Video Chunk ${i + 1}` });
            }

            const finalFilename = `${safeTitle} - ${safeChannel} (${videoFormat.quality_label}, h264).mp4`;
            session = {
                status: 'pending', videoFormat, audioFormat, tempDir,
                tempVideoFile: join(tempDir, 'video.mp4'),
                tempAudioFile: join(tempDir, 'audio.m4a'),
                finalFilename, finalFilePath: join(tempDir, finalFilename),
                videoTasks, audioTasks, isAudioOnly: false,
                createdAt: Date.now(), cleanupTimeoutId: null
            };
            responsePayload = {
                status: "ok", videoId, title,
                quality: `${videoFormat.quality_label}`, channel,
                thumbnail: info.basic_info.thumbnail?.at(0)?.url,
                filename: session.finalFilename, expiration: formatDuration(EXPIRATION_SECONDS),
                infoFetchTime: `${(performance.now() - getInfoStart).toFixed(2)}ms`
            };
        }

        downloadSessions.set(sessionId, session);
        scheduleSessionCleanup(sessionId, EXPIRATION_SECONDS * 1000);
        infoCache.set(cacheKey, { timestamp: Date.now(), data: { sessionData: session, responseData: responsePayload } });

        const requestUrl = new URL(request.url);
        return {
            ...responsePayload,
            cached: false,
            downloadLink: `${requestUrl.protocol}//${requestUrl.host}/stream/${isAudioRequest ? 'audio' : 'video'}/${sessionId}`
        };
    }, { query: t.Object({ url: t.String(), quality: t.Optional(t.String()), format: t.Optional(t.String()) }) })

    .get('/stream/video/:id', async ({ params, set }) => {
        const session = downloadSessions.get(params.id);
        if (!session || session.isAudioOnly) {
            set.status = 404;
            return { status: 'error', message: 'Download session not found or is audio-only.' };
        }
        if (session.status !== 'pending') {
            set.status = 409;
            return { status: 'error', message: 'This download has already started.' };
        }
        
        if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);
        
        try {
            await mkdir(session.tempDir, { recursive: true });
            session.status = 'downloading';
            await Promise.all([
                downloadAndCombineManager(params.id, session.videoTasks, session.tempVideoFile!),
                downloadAndCombineManager(params.id, session.audioTasks, session.tempAudioFile),
            ]);

            session.status = 'merging';
            if (!ffmpeg) throw new Error("FFmpeg static path not available.");
            const ffmpegStart = performance.now();
            const ffmpegArgs = ['-i', session.tempVideoFile!, '-i', session.tempAudioFile, '-c', 'copy', '-movflags', '+faststart', '-y', session.finalFilePath];
            
            const proc = Bun.spawn(ffmpegArgs, { stderr: 'pipe' });
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                const stderr = await new Response(proc.stderr).text();
                throw new Error(`FFmpeg failed with code ${exitCode}: ${stderr}`);
            }
            
            console.log(`[${params.id}] FFmpeg merge successful in ${(performance.now() - ffmpegStart).toFixed(2)}ms.`);
            
            session.status = 'completed';
            await Promise.all([Bun.file(session.tempVideoFile!).delete(), Bun.file(session.tempAudioFile).delete()]);
            
            const finalFile = Bun.file(session.finalFilePath);
            set.headers['Content-Disposition'] = `attachment; filename="${session.finalFilename}"`;
            return new Response(finalFile, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': finalFile.size.toString() } });
        } catch (error: any) {
            session.status = 'error';
            session.error = error.message;
            console.error(`[${params.id}] 🔴 Processing failed:`, error);
            scheduleSessionCleanup(params.id, 5000);
            set.status = 500;
            return { status: 'error', message: `Failed to process stream: ${error.message}` };
        }
    }, { params: t.Object({ id: t.String() }) })

    .get('/stream/audio/:id', async ({ params, set }) => {
        const session = downloadSessions.get(params.id);
        if (!session || !session.isAudioOnly) {
            set.status = 404;
            return { status: 'error', message: 'Download session not found or is not for audio.' };
        }
        if (session.status !== 'pending') {
            set.status = 409;
            return { status: 'error', message: 'This download has already started.' };
        }

        if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId);

        try {
            await mkdir(session.tempDir, { recursive: true });
            session.status = 'downloading';
            await downloadAndCombineManager(params.id, session.audioTasks, session.finalFilePath);
            
            session.status = 'completed';
            const finalFile = Bun.file(session.finalFilePath);
            set.headers['Content-Disposition'] = `attachment; filename="${session.finalFilename}"`;
            return new Response(finalFile, { headers: { 'Content-Type': 'audio/mp4', 'Content-Length': finalFile.size.toString() } });
        } catch (error: any) {
            session.status = 'error';
            session.error = error.message;
            console.error(`[${params.id}] 🔴 Audio processing failed:`, error);
            scheduleSessionCleanup(params.id, 5000);
            set.status = 500;
            return { status: 'error', message: `Failed to process stream: ${error.message}` };
        }
    }, { params: t.Object({ id: t.String() }) })
    
    .get('/insta', ({ query }) => instaHandler(query.url), { query: t.Object({ url: t.String() }) })
    .get('/instav2', ({ query }) => instav2Handler(query.url), { query: t.Object({ url: t.String() }) })
    .get('/fb', ({ query }) => fbHandler(query.url), { query: t.Object({ url: t.String() }) })
    .get('/tt', ({ query }) => ttHandler(query.url), { query: t.Object({ url: t.String() }) })
    .get('/x', ({ query }) => xHandler(query.url), { query: t.Object({ url: t.String() }) })
    .get('/pin', async ({ query, request, set }) => {
        const clientId = getClientId(request);
        if (query.search) {
            const limit = query.limit ? Math.min(parseInt(query.limit), 50) : 20;
            const result = await searchPinterest(query.search, clientId, limit);
            if (result.status === 'rate_limited') set.status = 429;
            return result;
        }
        if (query.url) {
            const result = await pinHandler(query.url, clientId);
            if (result.status === 'rate_limited') set.status = 429;
            return result;
        }
        set.status = 400;
        return { status: 'error', error: 'Missing "url" or "search" parameter.' };
    }, { query: t.Object({ url: t.Optional(t.String()), search: t.Optional(t.String()), limit: t.Optional(t.String()) }) })
    .get('/pin/stats', getCacheStats)
    .post('/pin/cache/clear', () => (clearCaches(), { status: 'success', message: 'Pinterest caches cleared' }))

    .listen({ port: PORT, idleTimeout: BUN_IDLE_TIMEOUT });

console.log(`🦊 Elysia API running at http://localhost:${app.server?.port}`);