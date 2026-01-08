import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static"; // Added from Old
import { Innertube, UniversalCache, Platform, Types, YT } from "youtubei.js";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import ffmpeg from "ffmpeg-static";

// --- Custom Imports from Old Code ---
import instaHandler from "./api/insta";
import instav2Handler from "./api/instav2";
import fbHandler from "./api/fb";
import pinHandler, {
  searchPinterest,
  getCacheStats,
  clearCaches,
} from "./api/pin";
import ttHandler from "./api/tt";
import xHandler from "./api/x";
import { getIp, getIpInfo } from "./handler/ip";
import { getDeviceInfo } from "./handler/device";
import { checkRateLimit, isSpam } from "./handler/protection";
import { getSystemStats } from "./handler/system";

// --- State Variables (New Code) ---
let activeOperations = 0; 
let activeRequests = 0;
let restartScheduled = false;
let shutdownTimer: Timer | null = null;

// --- Constants (Mixed) ---
const PORT = 3040; // Using New Code Port
const DOWNLOAD_DIR = join(process.cwd(), "downloads");
const TEMP_DIR_BASE = join(process.cwd(), "temp");

const MAX_CONCURRENT_DOWNLOADS = 16;
const DOWNLOAD_CHUNK_SIZE_MB = 1;
const IDLE_RESTART_DELAY_MS = 5000;

const SEARCH_CACHE_TTL = 5 * 60 * 60 * 1000;
const COOKIE_FILE_PATH = "cookies.txt"; 

// --- Type Definitions (New Code) ---
type YTInfo = YT.VideoInfo;
type ParsedYTFormat = NonNullable<
  YTInfo["streaming_data"]
>["adaptive_formats"][number];

interface MediaInfo {
  quality: string | undefined;
  size: string;
  codec: string;
  url: string;
}

interface SearchCacheEntry {
  results: VideoResult[];
  expires: number;
}

const searchCache = new Map<string, SearchCacheEntry>();

interface VideoResult {
  videoId: string;
  title: string;
  author: string;
  duration: string;
  thumbnail: string;
}

interface DownloadTask {
  index: number;
  format: ParsedYTFormat;
  start: number;
  end: number;
  description: string;
  retries: number;
}

interface TunnelSession {
  videoId: string;
  itag: number;
  info: YTInfo;
  player: any;
  bestAudioFormat: ParsedYTFormat;
  chosenVideoFormat?: ParsedYTFormat;
  expiryTimestamp: number;
  filename: string;
}

interface FileCacheEntry {
  filePath: string;
  filename: string;
  expiryTimeoutId: Timer;
}

interface VideoCacheEntry {
  info: YTInfo;
  player: any;
  tunnels: Map<number, string>;
  expiryTimestamp: number;
  bestAudioFormat: ParsedYTFormat;
}

const videoDataCache = new Map<string, VideoCacheEntry>();
const tunnelSessions = new Map<string, TunnelSession>();
const activeDownloads = new Map<string, Promise<FileCacheEntry>>();
const remuxedFileCache = new Map<string, FileCacheEntry>();

let innertube: Innertube;

// --- Helper Functions (Merged) ---

// From Old Code (Required for Pinterest)
function getClientId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  const cfConnecting = request.headers.get("cf-connecting-ip");

  return forwarded?.split(",")[0].trim() || realIp || cfConnecting || "unknown";
}

// From New Code
function getVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes("youtube.com")) {
      if (urlObj.pathname === "/watch") return urlObj.searchParams.get("v");
      const shortsMatch = urlObj.pathname.match(
        /^\/(shorts|live|embed)\/([a-zA-Z0-9_-]{11})/,
      );
      if (shortsMatch) return shortsMatch[2];
    }
    if (urlObj.hostname.includes("youtu.be"))
      return urlObj.pathname.split("/")[1];
  } catch (error) {
    console.warn(`Failed to parse video ID from URL: ${url}`, error);
  }
  return null;
}

async function getCookieFileContent(cookieFilePath: string): Promise<string> {
  const cookieFile = Bun.file(cookieFilePath);
  if (!(await cookieFile.exists())) {
    console.warn(
      `🔴 WARNING: Cookie file not found at '${cookieFilePath}'. Running unauthenticated.`,
    );
    return "";
  }
  return cookieFile.text();
}

function sanitizeFilename(name: string): string {
  let clean = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  clean = clean
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|#!]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length > 200) {
    clean = clean.substring(0, 200);
  }

  return clean || `video_${Date.now()}`;
}

function formatBytes(bytes: number | undefined, decimals = 2): string {
  if (bytes === undefined || bytes === null) return "N/A";
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${["Bytes", "KiB", "MiB", "GiB"][i]}`;
}

function formatDuration(_): string {
  const TUNNEL_LINK_EXPIRATION_HOURS = 5;
  const totalSeconds = TUNNEL_LINK_EXPIRATION_HOURS * 3600;

  if (totalSeconds < 3600) return `In ${Math.round(totalSeconds / 60)} minutes`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (minutes === 0) return `In ${hours} hour${hours > 1 ? "s" : ""}`;
  return `In ${hours} hour${hours > 1 ? "s" : ""} and ${minutes} minutes`;
}

function createContentDisposition(filename: string): string {
  const asciiFilename = filename.replace(/[^ -~]/g, "_");
  const encodedFilename = encodeURIComponent(filename);
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

// --- Caching and Cleanup (New Code) ---

async function cleanupCachedFile(cacheKey: string) {
  const cacheEntry = remuxedFileCache.get(cacheKey);
  if (cacheEntry) {
    console.log(`[Cache] Cleaning up expired file: ${cacheEntry.filename}`);
    remuxedFileCache.delete(cacheKey);
    try {
      await rm(cacheEntry.filePath, { force: true });
    } catch (err: any) {
      console.error(
        `[Cache] Error deleting cached file ${cacheEntry.filePath}:`,
        err.message,
      );
    }
  }
}

function scheduleFileCleanup(cacheKey: string) {
  const cacheEntry = remuxedFileCache.get(cacheKey);
  if (!cacheEntry) return;
  const REMUXED_FILE_CACHE_SECONDS = 300;
  if (cacheEntry.expiryTimeoutId) clearTimeout(cacheEntry.expiryTimeoutId);
  cacheEntry.expiryTimeoutId = setTimeout(
    () => cleanupCachedFile(cacheKey),
    REMUXED_FILE_CACHE_SECONDS * 1000,
  );
}

// --- Download Manager (New Code) ---

async function parallelDownloadManager(
  sessionId: string,
  tasks: DownloadTask[],
  destinationFile: string,
  mediaType: "Audio" | "Video",
  player: any,
) {
  if (!player)
    throw new Error("Player object is required for deciphering URLs.");
  const startTime = performance.now();
  const totalSize = tasks.reduce(
    (sum, task) => sum + (task.end - task.start + 1),
    0,
  );
  const actualWorkers = Math.min(tasks.length, MAX_CONCURRENT_DOWNLOADS);
  console.log(
    `[${sessionId}] ⬇️  Starting ${mediaType} download: ${tasks.length} chunks, ${formatBytes(totalSize)}. Using ${actualWorkers} workers...`,
  );
  const downloadedChunks = new Map<number, Buffer>();
  let chunksWritten = 0;
  const writer = Bun.file(destinationFile).writer();
  const processTask = async (
    task: DownloadTask,
    workerId: number,
  ): Promise<void> => {
    let attempt = 0;
    while (attempt <= task.retries) {
      try {
        const streamUrl = new URL(await task.format.decipher(player));
        const response = await fetch(streamUrl.toString(), {
          headers: { Range: `bytes=${task.start}-${task.end}` },
        });
        if (!response.ok)
          throw new Error(`Server responded with ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength !== task.end - task.start + 1)
          throw new Error(`Chunk ${task.index} size mismatch.`);
        downloadedChunks.set(task.index, buffer);
        while (downloadedChunks.has(chunksWritten)) {
          writer.write(downloadedChunks.get(chunksWritten)!);
          downloadedChunks.delete(chunksWritten);
          chunksWritten++;
        }
        return;
      } catch (error: any) {
        console.error(
          `\n[${sessionId}] Worker ${workerId} FAILED task ${task.description} (attempt ${attempt + 1}/${task.retries + 1}). Error: ${error.message}`,
        );
        if (attempt < task.retries) {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        } else {
          await writer.end();
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
  console.log(
    `[${sessionId}]    ✅ ${mediaType} Download Complete: ${formatBytes(totalSize)} in ${durationSec.toFixed(2)}s (${formatBytes(speed)}/s)`,
  );
  return destinationFile;
}

// --- Platform Shim (Shared) ---
Platform.shim.eval = async (
  data: Types.BuildScriptResult,
  env: Record<string, Types.VMPrimative>,
) => {
  const properties: string[] = [];
  if (env.n) {
    properties.push(
      `n: exportedVars.nFunction(${JSON.stringify(String(env.n))})`,
    );
  }
  if (env.sig) {
    properties.push(
      `sig: exportedVars.sigFunction(${JSON.stringify(String(env.sig))})`,
    );
  }
  const fullCode = `${data.output}\nreturn { ${properties.join(", ")} }`;
  return new Function(fullCode)();
};

// --- Setup ---
console.log("🚀 Server starting: Performing one-time expensive setup...");
const setupStartTime = performance.now();
const cookie = await getCookieFileContent(COOKIE_FILE_PATH);
innertube = await Innertube.create({
  cookie,
  cache: new UniversalCache(false),
});
if (!innertube.session.player) {
  console.warn(
    "⚠️ Innertube session is missing the Player object. Deciphering may fail.",
  );
}
console.log(
  `✅ One-time setup complete in ${(performance.now() - setupStartTime).toFixed(2)}ms.`,
);

// --- Lifecycle Management (New Code) ---
function scheduleIdleRestart() {
  if (!restartScheduled) return;

  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
  }

  console.log(
    `[Auto-Restart] Scheduling restart in ${IDLE_RESTART_DELAY_MS / 1000} seconds if server remains idle.`,
  );

  shutdownTimer = setTimeout(() => {
    if (activeOperations === 0 && activeRequests === 0) {
      gracefulShutdown("High latency detected and server is idle.");
    } else {
      console.log(
        `[Auto-Restart] Restart postponed. Server is not idle (Downloads: ${activeOperations}, Requests: ${activeRequests}).`,
      );
    }
  }, IDLE_RESTART_DELAY_MS);
}

async function gracefulShutdown(reason: string) {
  if (!restartScheduled) return;
  console.log(`[Graceful Shutdown] Initiating shutdown. Reason: ${reason}`);
  restartScheduled = false;

  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  await app.stop();
  console.log(
    "[Graceful Shutdown] Server has stopped accepting new connections.",
  );

  const waitForIdle = async () => {
    if (activeOperations === 0 && activeRequests === 0) {
      console.log("[Graceful Shutdown] All operations finished. Exiting now.");
      process.exit(0);
    } else {
      console.log(
        `[Graceful Shutdown] Waiting for operations to complete. Downloads: ${activeOperations}, Requests: ${activeRequests}`,
      );
      setTimeout(waitForIdle, 1000);
    }
  };

  await waitForIdle();
}

// --- Data Fetching Logic (New Code) ---

async function getOrFetchVideoData(videoId: string): Promise<{
  videoData: VideoCacheEntry;
  cacheHit: boolean;
  audioTunnelId: string;
}> {
  const cachedData = videoDataCache.get(videoId);
  if (cachedData && cachedData.expiryTimestamp > Date.now()) {
    console.log(`\n♻️  [${videoId}] Full Cache HIT.`);
    const audioFormat = cachedData.info.streaming_data?.adaptive_formats.find(
      (f) => f.itag === cachedData.bestAudioFormat.itag,
    );
    const audioTunnelId = audioFormat
      ? cachedData.tunnels.get(audioFormat.itag)
      : undefined;
    if (!audioTunnelId) throw new Error("Cached audio tunnel ID is missing.");
    return { videoData: cachedData, cacheHit: true, audioTunnelId };
  }

  console.log(`\n📥 [${videoId}] API Cache MISS. Fetching from YouTube.`);
  const infoFetchStart = performance.now();

  const playerResponse = await innertube.actions.execute("/player", {
    videoId,
    client: "WEB_EMBEDDED",
    playbackContext: {
      contentPlaybackContext: {
        signatureTimestamp: innertube.session.player?.signature_timestamp,
      },
    },
  });

  const info = new YT.VideoInfo([playerResponse], innertube.actions, videoId);
  const player = innertube.session.player!;
  const fetchDuration = performance.now() - infoFetchStart;
  console.log(`[${videoId}] Info fetched in ${fetchDuration.toFixed(2)}ms.`);

  if (fetchDuration > 20000 && !restartScheduled) {
    console.warn(`
    ####################################################################
    ## ⚠️  High Latency Detected: ${fetchDuration.toFixed(2)}ms.
    ## A safe restart will be triggered when the server is idle.
    ####################################################################
    `);
    restartScheduled = true;
    scheduleIdleRestart(); 
  }

  if (info.playability_status?.status !== "OK")
    throw new Error(`Video not playable: ${info.playability_status?.reason}`);
  if (!info.streaming_data) throw new Error("No streaming data found.");

  console.log(`\n✨ [${videoId}] Generating and caching all static URLs.`);
  const adaptiveFormats = info.streaming_data.adaptive_formats;
  const audio_only_streams = adaptiveFormats.filter(
    (f) => f.has_audio && !f.has_video,
  );
  let bestAudioFormat: ParsedYTFormat | undefined = audio_only_streams.find(
    (f) => f.audio_track?.audio_is_default,
  );
  if (!bestAudioFormat)
    bestAudioFormat = audio_only_streams.find((f) => f.is_original);
  if (!bestAudioFormat)
    bestAudioFormat = audio_only_streams.find((f) => f.itag === 140);
  if (!bestAudioFormat) {
    const m4a_formats = audio_only_streams
      .filter((f) => f.mime_type.includes("mp4a"))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    bestAudioFormat =
      m4a_formats.length > 0
        ? m4a_formats[0]
        : audio_only_streams.sort(
            (a, b) => (b.bitrate || 0) - (a.bitrate || 0),
          )[0];
  }
  if (!bestAudioFormat) throw new Error("No suitable audio format found.");

  const video_only_streams = adaptiveFormats.filter(
    (f) => f.has_video && !f.has_audio,
  );
  const selectedQualities = new Map<string, ParsedYTFormat>();
  ["1080p", "720p"].forEach((q) => {
    const vp9 =
      video_only_streams.find(
        (f) => f.quality_label === q && f.mime_type.includes("vp9"),
      ) ||
      video_only_streams.find(
        (f) => f.quality_label === q && f.mime_type.includes("avc1"),
      );
    if (vp9) selectedQualities.set(q, vp9);
  });
  ["480p", "360p", "240p", "144p"].forEach((q) => {
    const format = video_only_streams.find(
      (f) => f.quality_label === q && f.mime_type.includes("avc1"),
    );
    if (format) selectedQualities.set(q, format);
  });

  const tunnels = new Map<number, string>();
  const TUNNEL_LINK_EXPIRATION_HOURS = 5;
  const tunnelExpiry = Date.now() + TUNNEL_LINK_EXPIRATION_HOURS * 3600 * 1000;

  for (const format of selectedQualities.values()) {
    const tunnelId = Bun.randomUUIDv7();
    tunnels.set(format.itag, tunnelId);
    tunnelSessions.set(tunnelId, {
      videoId,
      itag: format.itag,
      info,
      player,
      bestAudioFormat,
      chosenVideoFormat: format,
      expiryTimestamp: tunnelExpiry,
      filename: "",
    });
  }

  const audioTunnelId = Bun.randomUUIDv7();
  tunnels.set(bestAudioFormat.itag, audioTunnelId);
  const audioFilename =
    sanitizeFilename(
      `${info.basic_info.title || "Unknown Title"} - ${info.basic_info.author || "Unknown Channel"}`,
    ).trim() + ".m4a";
  tunnelSessions.set(audioTunnelId, {
    videoId,
    itag: bestAudioFormat.itag,
    info,
    player,
    bestAudioFormat,
    chosenVideoFormat: undefined,
    expiryTimestamp: tunnelExpiry,
    filename: audioFilename,
  });

  const apiCacheExpirySeconds = Math.floor(
    (info.streaming_data.expires.getTime() - Date.now()) / 1000,
  );
  if (apiCacheExpirySeconds <= 60)
    console.warn(
      `[${videoId}] API response has a very short expiry time: ${apiCacheExpirySeconds}s.`,
    );

  const videoData: VideoCacheEntry = {
    info,
    player,
    tunnels,
    bestAudioFormat,
    expiryTimestamp: Date.now() + (apiCacheExpirySeconds - 60) * 1000,
  };
  if (apiCacheExpirySeconds > 60) {
    videoDataCache.set(videoId, videoData);
  }
  return { videoData, cacheHit: false, audioTunnelId };
}

async function getOrFetchSearchResults(
  searchQuery: string,
): Promise<{ results: VideoResult[]; fetchTime: number; cacheHit: boolean }> {
  const lookupStartTime = performance.now();
  const cacheKey = searchQuery.toLowerCase();
  const cachedEntry = searchCache.get(cacheKey);

  if (cachedEntry && cachedEntry.expires > Date.now()) {
    console.log(`\n♻️  [Search Cache] HIT for "${searchQuery}".`);
    const cacheFetchTime = performance.now() - lookupStartTime;
    return {
      results: cachedEntry.results,
      fetchTime: cacheFetchTime,
      cacheHit: true,
    };
  }

  console.log(
    `\n🔍 [API Search] MISS for "${searchQuery}". Fetching from YouTube.`,
  );
  const apiFetchStart = performance.now();

  const response = await innertube.actions.execute("/search", {
    query: searchQuery,
    client: "TV_EMBEDDED",
    parse: false,
  });

  const apiFetchTime = performance.now() - apiFetchStart;

  console.log(`\n⏱️ [API Search] Duration: ${apiFetchTime.toFixed(2)}ms`);

  const searchData: any = response.data;
  const results: VideoResult[] = [];
  const contents =
    searchData?.contents?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents;

  if (Array.isArray(contents)) {
    for (const item of contents) {
      const video = item.compactVideoRenderer;
      if (video) {
        const title = video.title?.runs?.[0]?.text;
        const videoId = video.videoId;
        const author = video.shortBylineText?.runs?.[0]?.text;
        const duration = video.lengthText?.runs?.[0]?.text;
        let thumbnail = "";
        const thumbnails = video.thumbnail?.thumbnails;

        if (Array.isArray(thumbnails) && thumbnails.length > 0) {
          thumbnail = thumbnails[thumbnails.length - 1].url;
        }

        if (videoId && title && author && duration) {
          results.push({ videoId, title, author, duration, thumbnail });
        }
      }
    }
  }

  if (results.length > 0) {
    searchCache.set(cacheKey, {
      results,
      expires: Date.now() + SEARCH_CACHE_TTL,
    });
  }

  return { results, fetchTime: apiFetchTime, cacheHit: false };
}

async function getOrStartDownload(
  session: TunnelSession,
  cacheKey: string,
  isAudioOnly: boolean,
): Promise<FileCacheEntry> {
  const { player, bestAudioFormat, chosenVideoFormat, filename } = session;
  let downloadPromise = activeDownloads.get(cacheKey);
  let cachedFile = remuxedFileCache.get(cacheKey);

  if (cachedFile) {
    console.log(`[${cacheKey}] ♻️  Cache HIT. Scheduling cleanup.`);
    scheduleFileCleanup(cacheKey);
    return cachedFile;
  }

  if (downloadPromise) {
    console.log(
      `[${cacheKey}] ⏳ Download in progress. Awaiting completion...`,
    );
    return downloadPromise;
  }

  const processPromise = (async (): Promise<FileCacheEntry> => {
    const tempDir = join(TEMP_DIR_BASE, Bun.randomUUIDv7());
    const tempAudioFile = join(
      tempDir,
      `audio.${bestAudioFormat.mime_type.includes("mp4a") ? "m4a" : "webm"}`,
    );
    await mkdir(tempDir, { recursive: true });

    try {
      const finalFilename = filename;
      const finalFilePath = join(DOWNLOAD_DIR, finalFilename);
      const targetChunkSizeBytes = DOWNLOAD_CHUNK_SIZE_MB * 1024 * 1024;

      if (isAudioOnly) {
        const tempDownloadPath = join(tempDir, "raw_audio.m4a");
        const audioContentLength = bestAudioFormat.content_length || 0;
        const audioTasks: DownloadTask[] = [];
        for (let i = 0, start = 0; start < audioContentLength; i++) {
          const end = Math.min(
            start + targetChunkSizeBytes - 1,
            audioContentLength - 1,
          );
          audioTasks.push({
            index: i,
            format: bestAudioFormat,
            start,
            end,
            retries: 2,
            description: `Audio Chunk ${i + 1}`,
          });
          start = end + 1;
        }
        await parallelDownloadManager(
          cacheKey,
          audioTasks,
          tempDownloadPath,
          "Audio",
          player,
        );
        console.log(`[${cacheKey}] 🔄 Starting Audio-Only Remux...`);
        const ffmpegStart = performance.now();
        const ffmpegArgs = [
          ffmpeg!,
          "-loglevel",
          "error",
          "-i",
          tempDownloadPath,
          "-c:a",
          "copy",
          "-movflags",
          "faststart",
          "-y",
          finalFilePath,
        ];
        const ffmpegProcess = Bun.spawn(ffmpegArgs, { stderr: "pipe" });
        if ((await ffmpegProcess.exited) !== 0)
          throw new Error(
            `FFmpeg failed during audio remux: ${await new Response(ffmpegProcess.stderr).text()}`,
          );
        console.log(
          `[${cacheKey}]    ✅ Audio Remux successful in ${(performance.now() - ffmpegStart).toFixed(2)}ms.`,
        );
      } else {
        if (!chosenVideoFormat)
          throw new Error("Chosen video format is missing for video download.");

        const audioContentLength = bestAudioFormat.content_length || 0;
        const audioTasks: DownloadTask[] = [];
        for (let i = 0, start = 0; start < audioContentLength; i++) {
          const end = Math.min(
            start + targetChunkSizeBytes - 1,
            audioContentLength - 1,
          );
          audioTasks.push({
            index: i,
            format: bestAudioFormat,
            start,
            end,
            retries: 2,
            description: `Audio Chunk ${i + 1}`,
          });
          start = end + 1;
        }

        const tempVideoFile = join(tempDir, `video.mp4`);
        const videoContentLength = chosenVideoFormat.content_length || 0;
        const videoTasks: DownloadTask[] = [];
        for (let i = 0, start = 0; start < videoContentLength; i++) {
          const end = Math.min(
            start + targetChunkSizeBytes - 1,
            videoContentLength - 1,
          );
          videoTasks.push({
            index: i,
            format: chosenVideoFormat,
            start,
            end,
            retries: 2,
            description: `Video Chunk ${i + 1}`,
          });
          start = end + 1;
        }

        await Promise.all([
          parallelDownloadManager(
            cacheKey,
            videoTasks,
            tempVideoFile,
            "Video",
            player,
          ),
          parallelDownloadManager(
            cacheKey,
            audioTasks,
            tempAudioFile,
            "Audio",
            player,
          ),
        ]);

        console.log(`[${cacheKey}] 🔄 Starting FFmpeg process...`);
        const ffmpegStart = performance.now();
        const ffmpegArgs = [
          ffmpeg!,
          "-i",
          tempVideoFile,
          "-i",
          tempAudioFile,
          "-c",
          "copy",
          "-y",
          finalFilePath,
        ];
        const ffmpegProcess = Bun.spawn(ffmpegArgs, { stderr: "pipe" });
        if ((await ffmpegProcess.exited) !== 0)
          throw new Error(
            `FFmpeg failed during video+audio remux: ${await new Response(ffmpegProcess.stderr).text()}`,
          );
        console.log(
          `[${cacheKey}]    ✅ FFmpeg successful in ${(performance.now() - ffmpegStart).toFixed(2)}ms.`,
        );
      }

      const newCacheEntry: FileCacheEntry = {
        filePath: finalFilePath,
        filename: finalFilename,
        expiryTimeoutId: null!,
      };
      remuxedFileCache.set(cacheKey, newCacheEntry);
      scheduleFileCleanup(cacheKey);
      return newCacheEntry;
    } finally {
      activeDownloads.delete(cacheKey);
      await rm(tempDir, { recursive: true, force: true });
    }
  })();

  activeDownloads.set(cacheKey, processPromise);
  console.log(`[${cacheKey}] ✨ New download initiated.`);
  return processPromise;
}

async function handleVideoRequest(
  videoId: string,
  query: { url: string; quality?: string; format?: string },
  request: Request,
  set: any,
  startTime: number,
) {
  const fetchedData: {
    videoData: VideoCacheEntry;
    cacheHit: boolean;
    audioTunnelId: string;
  } = (await getOrFetchVideoData(videoId)) as any;
  const { videoData, cacheHit, audioTunnelId } = fetchedData;
  const { info, tunnels, bestAudioFormat } = videoData;

  const requestUrl = new URL(request.url);
  const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
  const title = info.basic_info.title || "Unknown Title";
  const channel = info.basic_info.author || "Unknown Channel";
  const safeTitleWithChannel = sanitizeFilename(`${title} - ${channel}`);
  const bestThumbnail =
    info.basic_info.thumbnail?.find((t) => t.width > 1000)?.url ||
    info.basic_info.thumbnail?.[0]?.url ||
    "";
  const TUNNEL_LINK_EXPIRATION_HOURS = 5;

  for (const tunnelId of tunnels.values()) {
    const session = tunnelSessions.get(tunnelId);
    if (session && session.chosenVideoFormat) {
      const format = session.chosenVideoFormat;
      const videoCodec = format.mime_type.includes("vp9") ? "vp9" : "h264";
      session.filename = `${safeTitleWithChannel} (${format.quality_label}, ${videoCodec}).mp4`;
    }
  }

  if (query.format?.toLowerCase() === "m4a") {
    const audioSession = tunnelSessions.get(audioTunnelId);
    if (!audioSession) throw new Error("Audio tunnel session not found.");
    const responseData = {
      status: "ok",
      videoId,
      cached: cacheHit,
      title,
      quality: `128kbps`,
      channel,
      thumbnail: bestThumbnail,
      filename: audioSession.filename,
      size: formatBytes(bestAudioFormat.content_length),
      expires: formatDuration(TUNNEL_LINK_EXPIRATION_HOURS * 3600),
      infoFetchTime: `${(performance.now() - startTime).toFixed(2)}ms`,
      downloadLink: `${baseUrl}/tunnel/${audioTunnelId}`,
    };
    set.headers["Content-Type"] = "application/json; charset=utf-8";
    return new Response(JSON.stringify(responseData, null, 2));
  }

  if (!info.streaming_data)
    throw new Error("No streaming data found for this video.");
  const video_only_streams = info.streaming_data.adaptive_formats.filter(
    (f) => f.has_video && !f.has_audio,
  );
  const selectedQualities = new Map<string, ParsedYTFormat>();
  const qualityOrder = ["1080p", "720p", "480p", "360p", "240p", "144p"];
  ["1080p", "720p"].forEach((q) => {
    const vp9 = video_only_streams.find(
      (f) => f.quality_label === q && f.mime_type.includes("vp9"),
    );
    if (vp9) selectedQualities.set(q, vp9);
    else {
      const avc1 = video_only_streams.find(
        (f) => f.quality_label === q && f.mime_type.includes("avc1"),
      );
      if (avc1) selectedQualities.set(q, avc1);
    }
  });
  ["480p", "360p", "240p", "144p"].forEach((q) => {
    const format = video_only_streams.find(
      (f) => f.quality_label === q && f.mime_type.includes("avc1"),
    );
    if (format) selectedQualities.set(q, format);
  });

  if (query.quality) {
    let targetFormat: ParsedYTFormat | undefined;
    let requestedQuality = query.quality;
    if (!requestedQuality.endsWith("p")) requestedQuality += "p";
    const startIndex = qualityOrder.indexOf(requestedQuality);
    if (startIndex !== -1) {
      for (let i = startIndex; i < qualityOrder.length; i++) {
        const format = selectedQualities.get(qualityOrder[i]);
        if (format && tunnels.has(format.itag)) {
          targetFormat = format;
          break;
        }
      }
    }
    if (!targetFormat) {
      for (const qualityLabel of qualityOrder) {
        const format = selectedQualities.get(qualityLabel);
        if (format && tunnels.has(format.itag)) {
          targetFormat = format;
          break;
        }
      }
    }
    if (!targetFormat) {
      set.status = 404;
      return {
        success: false,
        error: "The requested quality is not available for this video.",
      };
    }
    const tunnelId = tunnels.get(targetFormat.itag);
    if (!tunnelId)
      throw new Error(
        "Could not find a cached tunnel ID for the requested format. This should not happen.",
      );
    const session = tunnelSessions.get(tunnelId);
    if (!session)
      throw new Error(
        "Session not found for tunnel ID. This should not happen.",
      );
    const qualityLabel = targetFormat.quality_label!;
    const size = formatBytes(
      (targetFormat.content_length || 0) +
        (bestAudioFormat.content_length || 0),
    );
    const responseData = {
      status: "ok",
      videoId,
      cached: cacheHit,
      title,
      quality: qualityLabel,
      channel,
      thumbnail: bestThumbnail,
      filename: session.filename,
      size,
      expires: formatDuration(TUNNEL_LINK_EXPIRATION_HOURS * 3600),
      infoFetchTime: `${(performance.now() - startTime).toFixed(2)}ms`,
      downloadLink: `${baseUrl}/tunnel/${tunnelId}`,
    };
    set.headers["Content-Type"] = "application/json; charset=utf-8";
    return new Response(JSON.stringify(responseData, null, 2));
  } else {
    const media: (MediaInfo & { filename: string })[] = [];
    for (const quality of qualityOrder) {
      const format = selectedQualities.get(quality);
      if (format) {
        const tunnelId = tunnels.get(format.itag);
        const session = tunnelId ? tunnelSessions.get(tunnelId) : undefined;
        if (session) {
          media.push({
            quality: format.quality_label,
            size: formatBytes(
              (format.content_length || 0) +
                (bestAudioFormat.content_length || 0),
            ),
            codec: format.mime_type.includes("vp9") ? "vp9" : "avc1",
            url: `${baseUrl}/tunnel/${tunnelId}`,
            filename: session.filename,
          });
        }
      }
    }
    const audioSession = tunnelSessions.get(audioTunnelId);
    if (audioSession && query.format?.toLowerCase() !== "mp4") {
      media.push({
        quality: "128kbps",
        size: formatBytes(bestAudioFormat.content_length),
        codec: "mp4a",
        url: `${baseUrl}/tunnel/${audioTunnelId}`,
        filename: audioSession.filename,
      });
    }
    const responseData = {
      success: true,
      videoId,
      cached: cacheHit,
      title,
      channel,
      thumbnail: bestThumbnail,
      expires: formatDuration(TUNNEL_LINK_EXPIRATION_HOURS * 3600),
      infofetchtime: `${(performance.now() - startTime).toFixed(2)}ms`,
      media,
    };
    set.headers["Content-Type"] = "application/json; charset=utf-8";
    return new Response(JSON.stringify(responseData, null, 2));
  }
}

// --- App Definitions ---

const app = new Elysia()
  // Add Static Plugin (Old Feature)
  .use(
    staticPlugin({
      assets: "public",
      prefix: "",
      alwaysStatic: true,
    }),
  )
  // Merged OnBeforeHandle: Stats + Protection
  .onBeforeHandle(({ request, set }) => {
    // 1. Protection Logic (Old)
    const ip = getIp(request);
    if (!checkRateLimit(ip)) {
      set.status = 429;
      return { status: "error", message: "Rate limit exceeded" };
    }
    if (isSpam(request)) {
      // Optional: block spam bots
      // set.status = 403;
      // return { status: "error", message: "Suspicious activity detected" };
    }

    // 2. Activity Logic (New)
    activeRequests++;
    // If a restart timer is running, any new request should postpone it.
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
      console.log("[Auto-Restart] Postponed due to new incoming request.");
    }
  })
  .onAfterHandle(({ response, set }) => {
    // 1. Activity Logic (New)
    activeRequests--;
    // If a restart is pending and the server is now fully idle, schedule the restart.
    if (restartScheduled && activeRequests === 0 && activeOperations === 0) {
      scheduleIdleRestart();
    }

    // 2. JSON Formatting (Old - adapted for checking response type)
    if (
        typeof response === "object" &&
        response !== null &&
        !(response instanceof Response)
    ) {
        set.headers["Content-Type"] = "application/json;charset=utf-8";
        // Elysia usually auto-stringifies, but force ensuring charset doesn't hurt
    }
  })
  .onStart(async () => {
    try {
        await mkdir(join(process.cwd(), "temp"), { recursive: true });
        await mkdir(DOWNLOAD_DIR, { recursive: true });
    } catch (err) {
        console.error("Failed to create temp directory:", err);
    }
    
    let hoursRunning = 0;
    console.log(`✅ API is running. Uptime logging has started.`);
    setInterval(
      () => {
        hoursRunning++;
        console.log(
          `\n---\n🕒 API has been running for ${hoursRunning} hour(s).\n---`,
        );
      },
      1000 * 60 * 60,
    );
    setInterval(
      () => {
        const now = Date.now();
        for (const [id, session] of tunnelSessions.entries()) {
          if (session.expiryTimestamp < now) tunnelSessions.delete(id);
        }
      },
      60 * 60 * 1000,
    );
  })
  // --- Old API Stats Endpoints ---
  .get("/api/stats", () => getSystemStats())
  .get("/api/ip", async ({ request }) => {
    const ip = getIp(request);
    return await getIpInfo(ip);
  })
  .get("/api/device", ({ request }) => getDeviceInfo(request))
  
  // --- Robots.txt (Old) ---
  .get(
    "/robots.txt",
    () =>
      new Response(["User-agent: *", "Disallow: /"].join("\n"), {
        headers: {
          "Content-Type": "text/plain",
        },
      }),
  )

  // --- Combined Root Handler (New YT Logic + Old Home.html) ---
  .get(
    "/",
    async ({ query, request, set }) => {
      // 1. If no URL param, serve Home HTML (Old Behavior)
      const { url } = query;
      if (!url) {
        return new Response(Bun.file("public/home.html"));
      }

      // 2. If URL param exists, use New Code YouTube Logic
      const startTime = performance.now();
      let videoId: string | null = null;
      try {
        videoId = getVideoId(url);
        if (!videoId) {
          set.status = 400;
          return {
            success: false,
            error: "Invalid or unsupported YouTube URL provided.",
          };
        }
        return await handleVideoRequest(
          videoId,
          query,
          request,
          set,
          startTime,
        );
      } catch (error: any) {
        set.status = 500;

        const errorPayload = {
          success: false,
          error: error?.message ?? "Unknown error",
          code: error?.code,
          name: error?.name,
          stack: error?.stack,
          playabilityStatus: error?.playabilityStatus,
          timestamp: new Date().toISOString(),
        };

        await Bun.write(
          "./last-error.json",
          JSON.stringify(errorPayload, null, 2),
        );

        return new Response(JSON.stringify(errorPayload, null, 2), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      } finally {
        const duration = (performance.now() - startTime).toFixed(2);
        console.log(
          `[${videoId || "Invalid URL"}] Request processed in ${duration}ms.`,
        );
      }
    },
    {
      query: t.Object({
        url: t.Optional(t.String()), // Made Optional to support serving HTML
        quality: t.Optional(t.String()),
        format: t.Optional(t.String()),
      }),
    },
  )
  
  // --- Pinterest Endpoint (Old) ---
  .get(
    "/pin",
    async ({ query, request, set }) => {
      const { url, search, limit } = query;
      const clientId = getClientId(request);

      if (search) {
        const searchLimit = limit ? Math.min(parseInt(limit), 50) : 20;
        const result = await searchPinterest(
          search as string,
          clientId,
          searchLimit,
        );
        if (result.status === "rate_limited") {
          set.status = 429;
          set.headers["Retry-After"] = "60";
        }
        return result;
      } else if (url) {
        const result = await pinHandler(url as string, clientId);
        if (result.status === "rate_limited") {
          set.status = 429;
          set.headers["Retry-After"] = "60";
        }
        return result;
      } else {
        set.status = 400;
        return {
          status: "error",
          error:
            'Missing required parameter: "url" for extraction or "search" for search.',
        };
      }
    },
    {
      query: t.Object({
        url: t.Optional(t.String()),
        search: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .get("/pin/stats", () => {
    return getCacheStats();
  })
  .post("/pin/cache/clear", () => {
    clearCaches();
    return {
      status: "success",
      message: "All Pinterest caches cleared",
    };
  })

  // --- Other Social Endpoints (Old) ---
  .get(
    "/insta",
    async ({ query }) => {
      const { url } = query;
      if (!url) throw new Error("Missing URL");
      return await instaHandler(url);
    },
    {
      query: t.Object({
        url: t.String(),
      }),
    },
  )
  .get(
    "/instav2",
    async ({ query }) => {
      const { url } = query;
      if (!url) throw new Error("Missing URL");
      return await instav2Handler(url);
    },
    {
      query: t.Object({
        url: t.String(),
      }),
    },
  )
  .get(
    "/fb",
    async ({ query }) => {
      const { url } = query;
      if (!url) throw new Error("Missing URL");
      return await fbHandler(url);
    },
    {
      query: t.Object({
        url: t.String(),
      }),
    },
  )
  .get(
    "/tt",
    async ({ query }) => {
      const { url } = query;
      if (!url) throw new Error("Missing URL");
      return await ttHandler(url);
    },
    {
      query: t.Object({
        url: t.String(),
      }),
    },
  )
  .get(
    "/x",
    async ({ query }) => {
      const { url } = query;
      if (!url) throw new Error("Missing URL");
      return await xHandler(url);
    },
    {
      query: t.Object({
        url: t.String(),
      }),
    },
  )

  // --- New Code YT Search & Music ---
  .get(
    "/search",
    async ({ query, request, set }) => {
      const startTime = performance.now();
      const { q: searchQuery, quality, format, num } = query;
      if (!searchQuery) {
        set.status = 400;
        return { success: false, error: "Query parameter 'q' is required." };
      }
      try {
        const { results, fetchTime, cacheHit } =
          await getOrFetchSearchResults(searchQuery);
        if (results.length === 0) {
          console.warn(
            `[Search: "${searchQuery}"] No parsable video results found.`,
          );
          set.status = 404;
          return {
            success: false,
            error: `No video results found for "${searchQuery}".`,
          };
        }
        if (num) {
          let finalResults = results;
          if (num.toLowerCase() !== "all") {
            const desiredCount = parseInt(num, 10);
            if (!isNaN(desiredCount) && desiredCount > 0) {
              finalResults = results.slice(0, desiredCount);
            }
          }
          const responsePayload = {
            infofetchtime: `${fetchTime.toFixed(2)}ms`,
            cache: cacheHit,
            results: finalResults,
          };
          set.status = 200;
          set.headers["Content-Type"] = "application/json; charset=utf-8";
          const duration = (performance.now() - startTime).toFixed(2);
          console.log(
            `[List Search: "${searchQuery}"] Request processed in ${duration}ms.`,
          );
          return JSON.stringify(responsePayload, null, 2);
        }
        const videoId = results[0].videoId;
        console.log(
          `✅ [Download Search] Found ID: ${videoId} (from ${cacheHit ? "cache" : "API"}). Handing off...`,
        );
        const mappedQuery = {
          url: `https://www.youtube.com/watch?v=${videoId}`,
          quality,
          format,
        };
        return await handleVideoRequest(
          videoId,
          mappedQuery,
          request,
          set,
          startTime,
        );
      } catch (error: any) {
        console.error(
          `\n❌ [Search] An error occurred for "${searchQuery}":`,
          error.message,
        );
        set.status = 500;
        return {
          success: false,
          error: "An internal error occurred during search.",
        };
      }
    },
    {
      query: t.Object({
        q: t.String(),
        quality: t.Optional(t.String()),
        format: t.Optional(t.String()),
        num: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/music",
    async ({ query, request, set }) => {
      const startTime = performance.now();
      const { q: songQuery, quality, format } = query;
      try {
        if (!songQuery) {
          set.status = 400;
          return { success: false, error: "Query parameter 'q' is required." };
        }
        console.log(`\n🎵 [Music Search] Searching for "${songQuery}"...`);
        const search = await innertube.music.search(songQuery);
        let song: any;
        let shelfType = "N/A";
        if (Array.isArray(search.contents)) {
          for (const item of search.contents) {
            if (
              item.type === "MusicCardShelf" &&
              (item as any).title?.endpoint?.payload?.videoId
            ) {
              song = item;
              shelfType = "MusicCardShelf";
              break;
            }
            if (item.type === "MusicShelf" && Array.isArray(item.contents)) {
              const foundSong = item.contents.find(
                (contentItem: any) =>
                  contentItem.videoId ||
                  contentItem.flex_columns?.[0]?.title?.endpoint?.payload
                    ?.videoId,
              );
              if (foundSong) {
                song = foundSong;
                shelfType = "MusicShelf";
                break;
              }
            }
          }
        }
        if (!song && search.songs?.contents?.length) {
          song = search.songs.contents.find((item: any) => item.videoId);
          if (song) shelfType = "songs";
        }
        if (!song && search.videos?.contents?.length) {
          song = search.videos.contents.find((item: any) => item.videoId);
          if (song) shelfType = "videos";
        }
        if (!song) {
          set.status = 404;
          console.warn(
            "No valid song item found in search results. Raw search object for debugging:",
          );
          console.dir(search, { depth: 2 });
          return {
            success: false,
            error: `No song results found for "${songQuery}".`,
          };
        }
        const title =
          (song as any).title?.text ||
          (song as any).title?.runs?.[0]?.text ||
          (song as any).flex_columns?.[0]?.title?.text ||
          (song as any).title ||
          (song as any).name ||
          "[No title]";
        const videoId =
          (song as any).videoId ||
          (song as any).endpoint?.payload?.videoId ||
          (song as any).title?.endpoint?.payload?.videoId ||
          (song as any).flex_columns?.[0]?.title?.endpoint?.payload?.videoId ||
          (song as any).id ||
          "";
        const fetchVidTime = performance.now() - startTime;
        if (!videoId) {
          set.status = 500;
          console.error(
            "Failed to extract ID from a confirmed song object:",
            song,
          );
          return {
            success: false,
            error: "Could not extract video ID from the top search result.",
          };
        }
        console.log(
          `✅ [Music Search] Found ID: ${videoId} (title: ${title}) [${shelfType}] in ${fetchVidTime.toFixed(2)}ms`,
        );
        const mappedQuery = {
          url: `https://www.youtube.com/watch?v=${videoId}`,
          quality,
          format,
        };
        return await handleVideoRequest(
          videoId,
          mappedQuery,
          request,
          set,
          startTime,
        );
      } catch (error: any) {
        console.error(
          `\n❌ [Music Search] An error occurred during search for "${songQuery}":`,
          error.message,
        );
        set.status = 500;
        return { success: false, error: error.message };
      } finally {
        const duration = (performance.now() - startTime).toFixed(2);
        console.log(
          `[Music Search: "${songQuery}"] Request processed in ${duration}ms.`,
        );
      }
    },
    {
      query: t.Object({
        q: t.String(),
        quality: t.Optional(t.String()),
        format: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/tunnel/:tunnelId",
    async ({ params, set }) => {
      const startTime = performance.now();
      const { tunnelId } = params;
      const session = tunnelSessions.get(tunnelId);
      if (!session || session.expiryTimestamp < Date.now()) {
        set.status = 404;
        return {
          success: false,
          error:
            "Download link not found or expired. Please generate a new one.",
        };
      }
      const { chosenVideoFormat } = session;
      const cacheKey = chosenVideoFormat
        ? `${session.videoId}-${session.itag}`
        : `${session.videoId}-audio-only`;
      const isAudioOnly = !chosenVideoFormat;
      activeOperations++;
      try {
        const cachedFile = await getOrStartDownload(
          session,
          cacheKey,
          isAudioOnly,
        );
        const file = Bun.file(cachedFile.filePath);
        if (!(await file.exists())) {
          throw new Error("Cached file was deleted unexpectedly.");
        }
        const handlerTimeMs = (performance.now() - startTime).toFixed(2);
        const contentType = isAudioOnly ? "audio/mp4" : "video/mp4";
        if (remuxedFileCache.has(cacheKey)) {
          console.log(
            `[${cacheKey}] ✅ Cached HIT. Handler time: ${handlerTimeMs}ms. Preparing to stream.`,
          );
        } else {
          console.log(
            `[${cacheKey}] ⏳ Non-cached stream initiated. Handler time: ${handlerTimeMs}ms.`,
          );
        }
        set.headers["Content-Disposition"] = createContentDisposition(
          cachedFile.filename,
        );
        set.headers["Content-Type"] = contentType;
        set.headers["Content-Length"] = file.size.toString();
        return new Response(file.stream());
      } catch (error: any) {
        activeDownloads.delete(cacheKey);
        console.error(`[${cacheKey}] ❌ Processing Error:`, error.message);
        set.status = 500;
        return {
          success: false,
          error: `Failed to process stream: ${error.message}`,
        };
      } finally {
        activeOperations--;
        console.log(
          `[State] Operation finished. Active operations: ${activeOperations}, Active requests: ${activeRequests}`,
        );

        if (
          restartScheduled &&
          activeOperations === 0 &&
          activeRequests === 0
        ) {
          console.log("[Auto-Restart] Last active download finished.");
          scheduleIdleRestart();
        }

        const totalTimeMs = (performance.now() - startTime).toFixed(2);
        if (!remuxedFileCache.has(cacheKey)) {
          console.log(`[${cacheKey}] Total non-cached time: ${totalTimeMs}ms.`);
        }
      }
    },
    { params: t.Object({ tunnelId: t.String() }) },
  )
  .listen(PORT);

// --- Process Signals ---

process.on("SIGINT", () => {
  console.log("\nReceived SIGINT (Ctrl+C).");
  restartScheduled = true;
  gracefulShutdown("Manual interrupt (SIGINT)");
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM.");
  restartScheduled = true;
  gracefulShutdown("Termination signal (SIGTERM)");
});

console.log(
  `🔥 Multi-Format Downloader API is running at http://${app.server?.hostname}:${app.server?.port}`,
);