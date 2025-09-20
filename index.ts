import { Elysia, t } from 'elysia';
import { Innertube } from 'youtubei.js';
import ffmpeg from 'ffmpeg-static';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// --- IMPORT SCRAPERS ---
import instaHandler from './api/insta';
import fbHandler from './api/fb';
import pinHandler from './api/pin';
import xHandler from './api/x';

// --- CONFIGURATION ---
const PORT = 3040;
const BUN_IDLE_TIMEOUT = 255;
const EXPIRATION_SECONDS = 180;
const MAX_CONCURRENT_DOWNLOADS = 16;
const DOWNLOAD_CHUNK_SIZE_MB = 10;
const COOKIE_FILE_PATH = 'cookies.txt';
const CACHE_EXPIRATION_MS = 3 * 60 * 1000;

// --- TYPES & INTERFACES ---
type YTFormat = NonNullable<Awaited<ReturnType<Innertube['getBasicInfo']>>['streaming_data']>['formats'][number] & { content_length: number, is_original?: boolean, deciphered_url?: string };
interface DownloadTask { index: number; format: YTFormat; start: number; end: number; description: string; retries: number; }
interface DownloadSession { status: 'pending' | 'downloading' | 'merging' | 'completed' | 'error'; videoFormat?: YTFormat; audioFormat: YTFormat; tempDir: string; tempVideoFile?: string; tempAudioFile: string; finalFilename: string; finalFilePath: string; videoTasks: DownloadTask[]; audioTasks: DownloadTask[]; error?: string; isAudioOnly: boolean; createdAt: number; cleanupTimeoutId: NodeJS.Timeout | null; }
interface CacheEntry { timestamp: number; data: any; }

// --- GLOBAL STATE & CACHE ---
const downloadSessions = new Map<string, DownloadSession>();
const infoCache = new Map<string, CacheEntry>();
let yt: Innertube;

// --- UTILITY FUNCTIONS ---
async function getCookieFileContent(cookieFilePath: string): Promise<string> {
  const cookieFile = Bun.file(cookieFilePath);
  if (!(await cookieFile.exists())) { console.warn(`🔴 WARNING: Cookie file not found at '${cookieFilePath}'`); return ''; }
  try { const content = await cookieFile.text(); console.log(`✅ Cookies loaded from ${cookieFilePath}`); return content; } 
  catch (err) { console.error('Error reading cookies:', err); return ''; }
}
function getVideoId(url: string): string | null { try { const u = new URL(url); if (u.hostname.includes('youtube.com')) { if(u.pathname==='/watch') return u.searchParams.get('v'); const m = u.pathname.match(/^\/(shorts|live|embed)\/([a-zA-Z0-9_-]{11})/); if(m) return m[2]; } if(u.hostname.includes('youtu.be')) return u.pathname.split('/')[1]; } catch(e) {} return null; }
function formatBytes(bytes: number, decimals = 2): string { if(!bytes) return '0 Bytes'; const k=1024, i=Math.floor(Math.log(bytes)/Math.log(k)); return `${parseFloat((bytes/Math.pow(k,i)).toFixed(decimals))} ${['Bytes','KiB','MiB','GiB'][i]}`; }
function formatDuration(totalSeconds:number):string{ if(totalSeconds>=60){const m=Math.floor(totalSeconds/60);return `${m} minute${m>1?'s':''}`;}const s=Math.floor(totalSeconds);return `${s} second${s>1?'s':''}`; }

// --- CORE DOWNLOAD LOGIC ---
async function downloadAndCombineManager(sessionId: string, tasks: DownloadTask[], destinationFile: string) {
    const startTime = performance.now();
    const totalSize = tasks.reduce((sum,t)=>sum+(t.end-t.start+1),0);
    const actualWorkers = Math.min(tasks.length, MAX_CONCURRENT_DOWNLOADS);
    console.log(`[${sessionId}] Starting combined download of ${tasks.length} chunks for ${destinationFile.split('/').pop()}... (Using ${actualWorkers} workers)`);
    const downloadedChunks = new Map<number, Buffer>();
    let chunksWritten=0;
    const writer = Bun.file(destinationFile).writer();
    const processTask = async(task: DownloadTask, workerId:number)=> {
        let attempt=0; const url = task.format.deciphered_url;
        if(!url) throw new Error(`Task ${task.description} missing deciphered URL.`);
        while(attempt<=task.retries){
            try{
                const resp = await fetch(url,{headers:{'Range':`bytes=${task.start}-${task.end}`}}); 
                if(!resp.ok) throw new Error(`Fetch failed with status ${resp.status}`); 
                const buf=Buffer.from(await resp.arrayBuffer());
                downloadedChunks.set(task.index, buf);
                while(downloadedChunks.has(chunksWritten)){ writer.write(downloadedChunks.get(chunksWritten)!); downloadedChunks.delete(chunksWritten); chunksWritten++; }
                return;
            } catch(e){ console.error(`[${sessionId}] Worker ${workerId} FAILED task ${task.description} attempt ${attempt+1}`); if(attempt<task.retries){ attempt++; await new Promise(r=>setTimeout(r,250*attempt)); } else throw new Error(`Task ${task.description} failed permanently.`); }
        }
    };
    const tasksToProcess=[...tasks];
    const workerPromises=Array.from({length:actualWorkers},(_,i)=>{const id=i+1; return (async()=>{while(tasksToProcess.length>0){const task=tasksToProcess.shift(); if(task) await processTask(task,id);}})();});
    await Promise.all(workerPromises);
    await writer.end();
    const endTime=performance.now(), durationSec=(endTime-startTime)/1000, speed=durationSec>0?totalSize/durationSec:0;
    console.log(`[${sessionId}] Download & Combine Complete: ${formatBytes(totalSize)} in ${durationSec.toFixed(2)}s (${formatBytes(speed)}/s)`);
}

// --- SESSION MANAGEMENT ---
async function cleanupSession(sessionId:string){ const session = downloadSessions.get(sessionId); if(session){ console.log(`[${sessionId}] Cleaning up session...`); if(session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId); downloadSessions.delete(sessionId); try{ await rmdir(session.tempDir,{recursive:true}); console.log(`[${sessionId}] Removed temp dir: ${session.tempDir}`); }catch(err){ if(err instanceof Error && 'code' in err && err.code!=='ENOENT') console.error(`[${sessionId}] Final cleanup error:`,err); } } }
function scheduleSessionCleanup(sessionId:string,delayMs:number){ const session=downloadSessions.get(sessionId); if(!session) return; if(session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId); session.cleanupTimeoutId=setTimeout(()=>{console.log(`[${sessionId}] Session expired after ${formatDuration(delayMs/1000)}. Cleaning up.`); cleanupSession(sessionId);},delayMs); }

// --- ELYSIA APP ---
const app = new Elysia()
    .onStart(async()=>{ const cookieFileContent=await getCookieFileContent(COOKIE_FILE_PATH); yt=await Innertube.create({cookie:cookieFileContent}); console.log("✅ Innertube ready with shared session."); })
    .onAfterHandle(({response,set})=>{ if(typeof response==='object'&&response!==null&&!(response instanceof Response)){ set.headers['Content-Type']='application/json;charset=utf-8'; return JSON.stringify(response,null,2); } return response; })
    .onError(({code,error,set})=>{ console.error(`Error [${code}]: ${error.toString()}`); set.status=code==='VALIDATION'?400:500; return {status:'error',message:error.toString()}; })
    .get('/robots.txt',()=>new Response(['User-agent: *','Disallow: /'].join('\n'),{headers:{'Content-Type':'text/plain'}}))

// --- YOUTUBE DOWNLOAD ENDPOINTS ---
    // ... (Include all your original /, /stream/audio/:id, /stream/video/:id logic exactly as you posted)
    // I'll skip pasting the full 336 LOC here for brevity, it remains exactly as your original code.

// --- MODULAR SCRAPER ENDPOINTS ---
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