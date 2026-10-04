import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import {
  Innertube,
  UniversalCache,
  Platform,
  Types,
  YT,
  YTNodes,
  ClientType,
  type IRawResponse,
} from "youtubei.js";
import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import {
  buildURL,
  parseLooseJSON,
  getHeaders,
  USER_AGENT,
} from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { JSDOM } from "jsdom";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import ffmpeg from "ffmpeg-static";

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
import {
  checkRateLimit,
  isSpam,
  ProtectionManager,
} from "./handler/protection";
import { getSystemStats } from "./handler/system";

let activeOperations = 0;
let activeRequests = 0;
let restartScheduled = false;
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

const PORT = 3040;
const DOWNLOAD_DIR = join(process.cwd(), "downloads");
const TEMP_DIR_BASE = join(process.cwd(), "temp");
const MAX_CONCURRENT_DOWNLOADS = 16;
const DOWNLOAD_CHUNK_SIZE_MB = 1;
const IDLE_RESTART_DELAY_MS = 5000;
const SEARCH_CACHE_TTL = 5 * 60 * 60 * 1000;
const COOKIE_FILE_PATH = "cookies.txt";
const ADMIN_USER = "PriyanshiKaurJi";
const ADMIN_PASS = "787957";
const TUNNEL_LINK_EXPIRATION_HOURS = 5;
const REMUXED_FILE_CACHE_SECONDS = 300;
const PO_REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";

type YTInfo = YT.VideoInfo;
type ParsedYTFormat =
  NonNullable<YTInfo["streaming_data"]>["adaptive_formats"][number];

interface MediaInfo {
  quality: string | undefined;
  size: string;
  codec: string;
  url: string;
  filename: string;
}

interface SearchCacheEntry {
  results: VideoResult[];
  expires: number;
}

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
  player: NonNullable<Innertube["session"]["player"]>;
  bestAudioFormat: ParsedYTFormat;
  chosenVideoFormat?: ParsedYTFormat;
  expiryTimestamp: number;
  filename: string;
}

interface FileCacheEntry {
  filePath: string;
  filename: string;
  expiryTimeoutId: ReturnType<typeof setTimeout> | null;
}

interface VideoCacheEntry {
  info: YTInfo;
  player: NonNullable<Innertube["session"]["player"]>;
  tunnels: Map<number, string>;
  expiryTimestamp: number;
  bestAudioFormat: ParsedYTFormat;
}

const searchCache = new Map<string, SearchCacheEntry>();
const videoDataCache = new Map<string, VideoCacheEntry>();
const tunnelSessions = new Map<string, TunnelSession>();
const activeDownloads = new Map<string, Promise<FileCacheEntry>>();
const remuxedFileCache = new Map<string, FileCacheEntry>();

let innertube: Innertube;
let webPoMinter: WebPoMinter | null = null;
let webPoMinterExpiresAt = 0;
let webPoMinterPromise: Promise<WebPoMinter> | null = null;

async function createWebPoMinter(): Promise<WebPoMinter> {
  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
    {
      url: "https://www.youtube.com/",
      referrer: "https://www.youtube.com/",
    },
  );

  const pageResponse = await fetch("https://www.youtube.com/", {
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.7",
      "user-agent": USER_AGENT,
    },
  });

  if (!pageResponse.ok) {
    throw new Error(
      `Could not load YouTube for PO token generation: HTTP ${pageResponse.status}`,
    );
  }

  const pageHtml = await pageResponse.text();
  const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];

  if (!ytConfig) {
    throw new Error("Could not find ytcfg in page HTML");
  }

  const domWindow = dom.window as typeof dom.window & {
    yt: { config_: Record<string, unknown> };
  };

  domWindow.yt = {
    config_: JSON.parse(ytConfig) as Record<string, unknown>,
  };

  Object.assign(globalThis, {
    yt: domWindow.yt,
    window: domWindow,
    document: domWindow.document,
    location: domWindow.location,
    origin: domWindow.origin,
  });

  if (!("navigator" in globalThis)) {
    Object.defineProperty(globalThis, "navigator", {
      value: domWindow.navigator,
      configurable: true,
    });
  }

  const initialAttestationData = pageHtml.match(
    /window\.ytAtN\(\s*({[\s\S]*?})\s*\)/,
  );

  if (!initialAttestationData) {
    throw new Error("Could not find BotGuard challenge in page HTML");
  }

  const initialAttestationDataJson = parseLooseJSON(
    initialAttestationData[1],
  ) as { R?: IRawResponse };
  const challengeResponse = initialAttestationDataJson.R;

  if (!challengeResponse?.bgChallenge) {
    throw new Error("Could not get BotGuard challenge");
  }

  const interpreterPath =
    challengeResponse.bgChallenge.interpreterUrl
      .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;

  if (!interpreterPath) {
    throw new Error("BotGuard interpreter URL is unavailable");
  }

  const interpreterUrl = interpreterPath.startsWith("http")
    ? interpreterPath
    : `https:${interpreterPath}`;
  const bgScriptResponse = await fetch(interpreterUrl);

  if (!bgScriptResponse.ok) {
    throw new Error(
      `Could not load BotGuard VM: HTTP ${bgScriptResponse.status}`,
    );
  }

  const interpreterJavascript = await bgScriptResponse.text();

  if (!interpreterJavascript) {
    throw new Error("Could not load BotGuard VM");
  }

  new Function(interpreterJavascript)();

  const botGuardClient = await BotGuardClient.create({
    program: challengeResponse.bgChallenge.program,
    globalName: challengeResponse.bgChallenge.globalName,
    globalObject: globalThis,
  });
  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({
    webPoSignalOutput,
  });
  const integrityTokenResponse = await fetch(buildURL("GenerateIT", true), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([PO_REQUEST_KEY, botguardResponse]),
  });

  if (!integrityTokenResponse.ok) {
    throw new Error(
      `Could not generate integrity token: HTTP ${integrityTokenResponse.status}`,
    );
  }

  const integrityTokenJson =
    (await integrityTokenResponse.json()) as [string, number, number, string];
  const [
    integrityToken,
    estimatedTtlSecs,
    mintRefreshThreshold,
    websafeFallbackToken,
  ] = integrityTokenJson;

  if (!integrityToken) {
    throw new Error("Integrity token response did not contain a token");
  }

  const minter = await WebPoMinter.create(
    {
      integrityToken,
      estimatedTtlSecs,
      mintRefreshThreshold,
      websafeFallbackToken,
    },
    webPoSignalOutput,
  );
  const refreshAfter = Math.max(
    60,
    Math.min(
      estimatedTtlSecs - 60,
      mintRefreshThreshold > 0 ? mintRefreshThreshold : estimatedTtlSecs - 300,
    ),
  );

  webPoMinterExpiresAt = Date.now() + refreshAfter * 1000;
  return minter;
}

async function getWebPoMinter(forceRefresh = false): Promise<WebPoMinter> {
  if (
    !forceRefresh &&
    webPoMinter &&
    Date.now() < webPoMinterExpiresAt
  ) {
    return webPoMinter;
  }

  if (!forceRefresh && webPoMinterPromise) {
    return webPoMinterPromise;
  }

  const promise = createWebPoMinter();
  webPoMinterPromise = promise;

  try {
    webPoMinter = await promise;
    return webPoMinter;
  } finally {
    if (webPoMinterPromise === promise) {
      webPoMinterPromise = null;
    }
  }
}

async function mintContentPoToken(videoId: string): Promise<string> {
  try {
    return await (await getWebPoMinter()).mintAsWebsafeString(videoId);
  } catch {
    webPoMinter = null;
    webPoMinterExpiresAt = 0;
    return (await getWebPoMinter(true)).mintAsWebsafeString(videoId);
  }
}

function addPoToken(url: string, poToken: string): string {
  if (!url) {
    throw new Error("Selected format has no downloadable URL");
  }

  const parsedUrl = new URL(url);
  parsedUrl.searchParams.set("pot", poToken);
  return parsedUrl.toString();
}

function hasDownloadableUrl(format: ParsedYTFormat): boolean {
  return Boolean(format.url || format.signature_cipher || format.cipher);
}

function getClientId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  const cfConnecting = request.headers.get("cf-connecting-ip");

  return forwarded?.split(",")[0].trim() || realIp || cfConnecting || "unknown";
}

function getVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();

    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const id = urlObj.pathname.split("/").filter(Boolean)[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com")
    ) {
      if (urlObj.pathname === "/watch") {
        const id = urlObj.searchParams.get("v");
        return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }

      const match = urlObj.pathname.match(
        /^\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]{11})/,
      );

      return match?.[1] ?? null;
    }
  } catch (error) {
    console.warn(`Failed to parse video ID from URL: ${url}`, error);
  }

  return null;
}

async function getCookieFileContent(cookieFilePath: string): Promise<string> {
  const cookieFile = Bun.file(cookieFilePath);

  if (!(await cookieFile.exists())) {
    console.warn(
      `Cookie file not found at "${cookieFilePath}". Running unauthenticated.`,
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
    clean = clean.slice(0, 200);
  }

  return clean || `video_${Date.now()}`;
}

function formatBytes(bytes: number | undefined, decimals = 2): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) {
    return "N/A";
  }

  if (bytes === 0) {
    return "0 Bytes";
  }

  const units = ["Bytes", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );

  return `${parseFloat(
    (bytes / Math.pow(1024, index)).toFixed(decimals),
  )} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));

  if (totalSeconds < 3600) {
    return `In ${Math.max(1, Math.round(totalSeconds / 60))} minutes`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);

  if (minutes === 0) {
    return `In ${hours} hour${hours === 1 ? "" : "s"}`;
  }

  return `In ${hours} hour${hours === 1 ? "" : "s"} and ${minutes} minutes`;
}

function createContentDisposition(filename: string): string {
  const asciiFilename = filename.replace(/[^ -~]/g, "_");
  const encodedFilename = encodeURIComponent(filename);

  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

function getFormatContentLength(format: ParsedYTFormat): number {
  const value = format.content_length;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getFormatExtension(format: ParsedYTFormat, fallback: string): string {
  const mimeType = format.mime_type || "";
  const match = mimeType.match(/\/([a-zA-Z0-9]+)/);

  if (!match) {
    return fallback;
  }

  const extension = match[1].toLowerCase();

  if (extension === "mp4") {
    return "mp4";
  }

  if (extension === "webm") {
    return "webm";
  }

  return fallback;
}

function createDownloadTasks(
  format: ParsedYTFormat,
  description: string,
): DownloadTask[] {
  const contentLength = getFormatContentLength(format);

  if (contentLength <= 0) {
    throw new Error(
      `Missing or invalid content length for ${description.toLowerCase()}.`,
    );
  }

  const chunkSize = DOWNLOAD_CHUNK_SIZE_MB * 1024 * 1024;
  const tasks: DownloadTask[] = [];

  for (let index = 0, start = 0; start < contentLength; index++) {
    const end = Math.min(start + chunkSize - 1, contentLength - 1);

    tasks.push({
      index,
      format,
      start,
      end,
      description: `${description} Chunk ${index + 1}`,
      retries: 2,
    });

    start = end + 1;
  }

  return tasks;
}

function getVideoFormats(info: YTInfo): ParsedYTFormat[] {
  return (info.streaming_data?.adaptive_formats || []).filter(
    (format) =>
      format.has_video &&
      !format.has_audio &&
      hasDownloadableUrl(format),
  );
}

function getAudioFormats(info: YTInfo): ParsedYTFormat[] {
  return (info.streaming_data?.adaptive_formats || []).filter(
    (format) =>
      format.has_audio &&
      !format.has_video &&
      hasDownloadableUrl(format),
  );
}

function selectBestAudioFormat(info: YTInfo): ParsedYTFormat {
  const audioFormats = getAudioFormats(info);

  if (audioFormats.length === 0) {
    throw new Error("No audio-only stream was found.");
  }

  const defaultAudio = audioFormats.find(
    (format) => format.audio_track?.audio_is_default,
  );

  if (defaultAudio) {
    return defaultAudio;
  }

  const originalAudio = audioFormats.find((format) => format.is_original);

  if (originalAudio) {
    return originalAudio;
  }

  const itag140 = audioFormats.find((format) => format.itag === 140);

  if (itag140) {
    return itag140;
  }

  const mp4aAudio = audioFormats
    .filter((format) => format.mime_type?.includes("mp4a"))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  return (
    mp4aAudio ||
    audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
  );
}

function selectVideoQualities(info: YTInfo): Map<string, ParsedYTFormat> {
  const videoFormats = getVideoFormats(info);
  const qualities = new Map<string, ParsedYTFormat>();

  for (const quality of ["1080p", "720p"]) {
    const vp9 = videoFormats.find(
      (format) =>
        format.quality_label === quality && format.mime_type?.includes("vp9"),
    );

    const avc1 = videoFormats.find(
      (format) =>
        format.quality_label === quality && format.mime_type?.includes("avc1"),
    );

    const av01 = videoFormats.find(
      (format) =>
        format.quality_label === quality && format.mime_type?.includes("av01"),
    );

    const selected = vp9 || avc1 || av01;

    if (selected) {
      qualities.set(quality, selected);
    }
  }

  for (const quality of ["480p", "360p", "240p", "144p"]) {
    const avc1 = videoFormats.find(
      (format) =>
        format.quality_label === quality && format.mime_type?.includes("avc1"),
    );

    const vp9 = videoFormats.find(
      (format) =>
        format.quality_label === quality && format.mime_type?.includes("vp9"),
    );

    const av01 = videoFormats.find(
      (format) =>
        format.quality_label === quality && format.mime_type?.includes("av01"),
    );

    const selected = avc1 || vp9 || av01;

    if (selected) {
      qualities.set(quality, selected);
    }
  }

  return qualities;
}

function getApiCacheExpiry(info: YTInfo): number {
  const expires = info.streaming_data?.expires;

  if (!(expires instanceof Date) || Number.isNaN(expires.getTime())) {
    return Date.now() + 15 * 60 * 1000;
  }

  return Math.max(Date.now() + 60 * 1000, expires.getTime() - 60 * 1000);
}

async function cleanupCachedFile(cacheKey: string): Promise<void> {
  const cacheEntry = remuxedFileCache.get(cacheKey);

  if (!cacheEntry) {
    return;
  }

  remuxedFileCache.delete(cacheKey);

  try {
    await rm(cacheEntry.filePath, { force: true });
  } catch (error) {
    console.error(
      `[Cache] Failed to remove ${cacheEntry.filePath}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function scheduleFileCleanup(cacheKey: string): void {
  const cacheEntry = remuxedFileCache.get(cacheKey);

  if (!cacheEntry) {
    return;
  }

  if (cacheEntry.expiryTimeoutId) {
    clearTimeout(cacheEntry.expiryTimeoutId);
  }

  cacheEntry.expiryTimeoutId = setTimeout(() => {
    void cleanupCachedFile(cacheKey);
  }, REMUXED_FILE_CACHE_SECONDS * 1000);
}

async function parallelDownloadManager(
  sessionId: string,
  tasks: DownloadTask[],
  destinationFile: string,
  mediaType: "Audio" | "Video",
  player: NonNullable<Innertube["session"]["player"]>,
  poToken: string,
): Promise<string> {
  if (!player) {
    throw new Error("YouTube player is unavailable for stream deciphering.");
  }

  if (tasks.length === 0) {
    throw new Error(`No ${mediaType.toLowerCase()} download tasks were created.`);
  }

  const startTime = performance.now();
  const totalSize = tasks.reduce(
    (sum, task) => sum + (task.end - task.start + 1),
    0,
  );
  const workerCount = Math.min(tasks.length, MAX_CONCURRENT_DOWNLOADS);
  const downloadedChunks = new Map<number, Buffer>();
  const writer = Bun.file(destinationFile).writer();
  const queue = [...tasks];
  let nextChunkToWrite = 0;
  let writerClosed = false;

  const closeWriter = async () => {
    if (!writerClosed) {
      writerClosed = true;
      await writer.end();
    }
  };

  const writeAvailableChunks = () => {
    while (downloadedChunks.has(nextChunkToWrite)) {
      const chunk = downloadedChunks.get(nextChunkToWrite);

      if (!chunk) {
        break;
      }

      writer.write(chunk);
      downloadedChunks.delete(nextChunkToWrite);
      nextChunkToWrite++;
    }
  };

  const processTask = async (
    task: DownloadTask,
    workerId: number,
  ): Promise<void> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= task.retries; attempt++) {
      try {
        const decipheredUrl = addPoToken(
          await task.format.decipher(player),
          poToken,
        );
        const response = await fetch(decipheredUrl, {
          headers: {
            Range: `bytes=${task.start}-${task.end}`,
          },
        });

        if (!(response.ok || response.status === 206)) {
          throw new Error(`YouTube responded with HTTP ${response.status}.`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const expectedLength = task.end - task.start + 1;

        if (buffer.byteLength !== expectedLength) {
          throw new Error(
            `Expected ${expectedLength} bytes but received ${buffer.byteLength} bytes.`,
          );
        }

        downloadedChunks.set(task.index, buffer);
        writeAvailableChunks();
        return;
      } catch (error) {
        lastError = error;

        if (attempt < task.retries) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1)),
          );
        }
      }
    }

    throw new Error(
      `[${sessionId}] ${mediaType} worker ${workerId} failed ${task.description}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  };

  try {
    await Promise.all(
      Array.from({ length: workerCount }, (_, workerIndex) =>
        (async () => {
          while (queue.length > 0) {
            const task = queue.shift();

            if (task) {
              await processTask(task, workerIndex + 1);
            }
          }
        })(),
      ),
    );

    await closeWriter();

    const durationSeconds = (performance.now() - startTime) / 1000;
    const speed = durationSeconds > 0 ? totalSize / durationSeconds : 0;

    console.log(
      `[${sessionId}] ${mediaType} download complete: ${formatBytes(
        totalSize,
      )} in ${durationSeconds.toFixed(2)}s (${formatBytes(speed)}/s).`,
    );

    return destinationFile;
  } catch (error) {
    await closeWriter();
    throw error;
  }
}

Platform.shim.eval = async (
  data: Types.BuildScriptResult,
): Promise<Record<string, unknown>> => {
  return new Function(data.output)();
};

console.log("Server starting: performing one-time setup.");

const setupStartTime = performance.now();
const cookie = await getCookieFileContent(COOKIE_FILE_PATH);
await getWebPoMinter();

innertube = await Innertube.create({
  cookie: cookie || undefined,
  cache: new UniversalCache(false),
  client_type: ClientType.WEB,
  retrieve_player: true,
  retrieve_innertube_config: true,
});

if (!innertube.session.player) {
  throw new Error(
    "YouTube player initialization failed. Stream deciphering cannot continue.",
  );
}

console.log(
  `One-time setup complete in ${(performance.now() - setupStartTime).toFixed(2)}ms.`,
);

function scheduleIdleRestart(): void {
  if (!restartScheduled) {
    return;
  }

  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
  }

  shutdownTimer = setTimeout(() => {
    if (activeOperations === 0 && activeRequests === 0) {
      void gracefulShutdown("Server is idle after a scheduled restart.");
    }
  }, IDLE_RESTART_DELAY_MS);
}

async function gracefulShutdown(reason: string): Promise<void> {
  if (!restartScheduled) {
    return;
  }

  restartScheduled = false;

  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  console.log(`[Graceful Shutdown] ${reason}`);

  await app.stop();

  while (activeOperations > 0 || activeRequests > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  process.exit(0);
}

async function getOrFetchVideoData(
  videoId: string,
): Promise<{
  videoData: VideoCacheEntry;
  cacheHit: boolean;
  audioTunnelId: string;
}> {
  const cachedData = videoDataCache.get(videoId);

  if (cachedData && cachedData.expiryTimestamp > Date.now()) {
    const audioTunnelId = cachedData.tunnels.get(
      cachedData.bestAudioFormat.itag,
    );

    if (!audioTunnelId) {
      throw new Error("Cached audio tunnel ID is missing.");
    }

    return {
      videoData: cachedData,
      cacheHit: true,
      audioTunnelId,
    };
  }

  videoDataCache.delete(videoId);

  const infoFetchStart = performance.now();
  const contentPoToken = await mintContentPoToken(videoId);
  const info = await innertube.getBasicInfo(videoId, {
    client: "YTMUSIC",
    po_token: contentPoToken,
  });
  const fetchDuration = performance.now() - infoFetchStart;
  const player = innertube.session.player;

  if (!player) {
    throw new Error("YouTube player is unavailable after video info retrieval.");
  }

  console.log(
    `[${videoId}] Video info fetched in ${fetchDuration.toFixed(2)}ms.`,
  );

  if (fetchDuration > 20000 && !restartScheduled) {
    restartScheduled = true;
    scheduleIdleRestart();
  }

  if (info.playability_status?.status !== "OK") {
    throw new Error(
      `Video not playable: ${
        info.playability_status?.reason || info.playability_status?.status
      }`,
    );
  }

  if (!info.streaming_data?.adaptive_formats?.length) {
    throw new Error("No adaptive streaming formats were found.");
  }

  const bestAudioFormat = selectBestAudioFormat(info);
  const selectedQualities = selectVideoQualities(info);
  const tunnels = new Map<number, string>();
  const expiryTimestamp =
    Date.now() + TUNNEL_LINK_EXPIRATION_HOURS * 60 * 60 * 1000;

  const title = info.basic_info.title || "Unknown Title";
  const channel = info.basic_info.author || "Unknown Channel";
  const safeBaseName = sanitizeFilename(`${title} - ${channel}`);

  for (const format of selectedQualities.values()) {
    const tunnelId = Bun.randomUUIDv7();
    const codec = format.mime_type?.includes("vp9")
      ? "vp9"
      : format.mime_type?.includes("av01")
        ? "av1"
        : "h264";

    tunnels.set(format.itag, tunnelId);

    tunnelSessions.set(tunnelId, {
      videoId,
      itag: format.itag,
      info,
      player,
      bestAudioFormat,
      chosenVideoFormat: format,
      expiryTimestamp,
      filename: `${safeBaseName} (${format.quality_label || "video"}, ${codec}).mp4`,
    });
  }

  const audioTunnelId = Bun.randomUUIDv7();
  const audioExtension = bestAudioFormat.mime_type?.includes("mp4a")
    ? "m4a"
    : "webm";

  tunnels.set(bestAudioFormat.itag, audioTunnelId);

  tunnelSessions.set(audioTunnelId, {
    videoId,
    itag: bestAudioFormat.itag,
    info,
    player,
    bestAudioFormat,
    expiryTimestamp,
    filename: `${safeBaseName}.${audioExtension}`,
  });

  const videoData: VideoCacheEntry = {
    info,
    player,
    tunnels,
    bestAudioFormat,
    expiryTimestamp: getApiCacheExpiry(info),
  };

  videoDataCache.set(videoId, videoData);

  return {
    videoData,
    cacheHit: false,
    audioTunnelId,
  };
}

async function getOrFetchSearchResults(
  searchQuery: string,
): Promise<{
  results: VideoResult[];
  fetchTime: number;
  cacheHit: boolean;
}> {
  const startTime = performance.now();
  const cacheKey = searchQuery.trim().toLowerCase();
  const cachedEntry = searchCache.get(cacheKey);

  if (cachedEntry && cachedEntry.expires > Date.now()) {
    return {
      results: cachedEntry.results,
      fetchTime: performance.now() - startTime,
      cacheHit: true,
    };
  }

  searchCache.delete(cacheKey);

  const search = await innertube.search(searchQuery, { type: "video" });
  const results: VideoResult[] = [];

  for (const item of search.results) {
    if (item.is(YTNodes.Video)) {
      results.push({
        videoId: item.video_id,
        title: item.title.toString(),
        author: item.author.name,
        duration: item.duration.text || "Unknown",
        thumbnail: item.best_thumbnail?.url || "",
      });
      continue;
    }

    if (
      item.is(YTNodes.LockupView) &&
      (item.content_type === "VIDEO" || item.content_type === "SHORT") &&
      /^[a-zA-Z0-9_-]{11}$/.test(item.content_id)
    ) {
      const thumbnail = item.content_image?.is(YTNodes.ThumbnailView)
        ? item.content_image.image.at(-1)?.url || ""
        : "";
      const metadataRows = item.metadata?.metadata?.metadata_rows || [];
      const metadataText = metadataRows
        .flatMap((row) => row.metadata_parts || [])
        .map((part) => part.text?.toString() || "")
        .filter(Boolean);
      const duration =
        metadataText.find((text) => /^\d+(?::[0-5]\d)+$/.test(text)) ||
        "Unknown";
      const author =
        metadataText.find((text) => !/^\d+(?::[0-5]\d)+$/.test(text)) ||
        "Unknown Channel";

      results.push({
        videoId: item.content_id,
        title: item.metadata?.title.toString() || "Unknown Title",
        author,
        duration,
        thumbnail,
      });
    }
  }

  if (results.length > 0) {
    searchCache.set(cacheKey, {
      results,
      expires: Date.now() + SEARCH_CACHE_TTL,
    });
  }

  return {
    results,
    fetchTime: performance.now() - startTime,
    cacheHit: false,
  };
}

async function getOrStartDownload(
  session: TunnelSession,
  cacheKey: string,
  isAudioOnly: boolean,
): Promise<FileCacheEntry> {
  const cachedFile = remuxedFileCache.get(cacheKey);

  if (cachedFile) {
    scheduleFileCleanup(cacheKey);
    return cachedFile;
  }

  const existingDownload = activeDownloads.get(cacheKey);

  if (existingDownload) {
    return existingDownload;
  }

  const downloadPromise = (async (): Promise<FileCacheEntry> => {
    const tempDir = join(TEMP_DIR_BASE, Bun.randomUUIDv7());

    try {
      const contentPoToken = await mintContentPoToken(session.videoId);
      await mkdir(tempDir, { recursive: true });

      const finalFilename = session.filename;
      const finalFilePath = join(DOWNLOAD_DIR, finalFilename);
      const audioFormat = session.bestAudioFormat;
      const audioExtension = getFormatExtension(
        audioFormat,
        audioFormat.mime_type?.includes("mp4a") ? "m4a" : "webm",
      );

      if (isAudioOnly) {
        const rawAudioPath = join(tempDir, `audio.${audioExtension}`);
        const audioTasks = createDownloadTasks(audioFormat, "Audio");

        await parallelDownloadManager(
          cacheKey,
          audioTasks,
          rawAudioPath,
          "Audio",
          session.player,
          contentPoToken,
        );

        const ffmpegArgs = audioFormat.mime_type?.includes("mp4a")
          ? [
              ffmpeg!,
              "-loglevel",
              "error",
              "-i",
              rawAudioPath,
              "-c:a",
              "copy",
              "-movflags",
              "faststart",
              "-y",
              finalFilePath,
            ]
          : [
              ffmpeg!,
              "-loglevel",
              "error",
              "-i",
              rawAudioPath,
              "-vn",
              "-c:a",
              "copy",
              "-y",
              finalFilePath,
            ];

        const ffmpegProcess = Bun.spawn(ffmpegArgs, {
          stdout: "ignore",
          stderr: "pipe",
        });

        if ((await ffmpegProcess.exited) !== 0) {
          const stderr = await new Response(ffmpegProcess.stderr).text();
          throw new Error(`FFmpeg audio remux failed: ${stderr}`);
        }
      } else {
        const videoFormat = session.chosenVideoFormat;

        if (!videoFormat) {
          throw new Error("A video stream was not selected for this request.");
        }

        const videoExtension = getFormatExtension(videoFormat, "mp4");
        const rawVideoPath = join(tempDir, `video.${videoExtension}`);
        const rawAudioPath = join(tempDir, `audio.${audioExtension}`);
        const videoTasks = createDownloadTasks(videoFormat, "Video");
        const audioTasks = createDownloadTasks(audioFormat, "Audio");

        await Promise.all([
          parallelDownloadManager(
            cacheKey,
            videoTasks,
            rawVideoPath,
            "Video",
            session.player,
            contentPoToken,
          ),
          parallelDownloadManager(
            cacheKey,
            audioTasks,
            rawAudioPath,
            "Audio",
            session.player,
            contentPoToken,
          ),
        ]);

        const ffmpegProcess = Bun.spawn(
          [
            ffmpeg!,
            "-loglevel",
            "error",
            "-i",
            rawVideoPath,
            "-i",
            rawAudioPath,
            "-c",
            "copy",
            "-movflags",
            "faststart",
            "-y",
            finalFilePath,
          ],
          {
            stdout: "ignore",
            stderr: "pipe",
          },
        );

        if ((await ffmpegProcess.exited) !== 0) {
          const stderr = await new Response(ffmpegProcess.stderr).text();
          throw new Error(`FFmpeg video remux failed: ${stderr}`);
        }
      }

      const cacheEntry: FileCacheEntry = {
        filePath: finalFilePath,
        filename: finalFilename,
        expiryTimeoutId: null,
      };

      remuxedFileCache.set(cacheKey, cacheEntry);
      scheduleFileCleanup(cacheKey);

      return cacheEntry;
    } finally {
      activeDownloads.delete(cacheKey);
      await rm(tempDir, { recursive: true, force: true });
    }
  })();

  activeDownloads.set(cacheKey, downloadPromise);

  return downloadPromise;
}

async function handleVideoRequest(
  videoId: string,
  query: {
    url: string;
    quality?: string;
    format?: string;
  },
  request: Request,
  set: any,
  startTime: number,
) {
  const { videoData, cacheHit, audioTunnelId } =
    await getOrFetchVideoData(videoId);

  const { info, tunnels, bestAudioFormat } = videoData;
  const requestUrl = new URL(request.url);
  const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
  const title = info.basic_info.title || "Unknown Title";
  const channel = info.basic_info.author || "Unknown Channel";
  const bestThumbnail =
    info.basic_info.thumbnail?.find((thumbnail) => thumbnail.width >= 1000)
      ?.url ||
    info.basic_info.thumbnail?.at(-1)?.url ||
    "";

  if (query.format?.toLowerCase() === "m4a") {
    const audioSession = tunnelSessions.get(audioTunnelId);

    if (!audioSession) {
      throw new Error("Audio tunnel session was not found.");
    }

    set.headers["Content-Type"] = "application/json; charset=utf-8";

    return new Response(
      JSON.stringify(
        {
          status: "ok",
          videoId,
          cached: cacheHit,
          title,
          quality: "audio",
          channel,
          thumbnail: bestThumbnail,
          filename: audioSession.filename,
          size: formatBytes(getFormatContentLength(bestAudioFormat)),
          expires: formatDuration(TUNNEL_LINK_EXPIRATION_HOURS * 3600),
          infoFetchTime: `${(performance.now() - startTime).toFixed(2)}ms`,
          downloadLink: `${baseUrl}/tunnel/${audioTunnelId}`,
        },
        null,
        2,
      ),
    );
  }

  const selectedQualities = selectVideoQualities(info);
  const qualityOrder = ["1080p", "720p", "480p", "360p", "240p", "144p"];

  if (query.quality) {
    const normalizedQuality = query.quality.endsWith("p")
      ? query.quality
      : `${query.quality}p`;

    const requestedIndex = qualityOrder.indexOf(normalizedQuality);
    let targetFormat: ParsedYTFormat | undefined;

    if (requestedIndex >= 0) {
      for (const quality of qualityOrder.slice(requestedIndex)) {
        const format = selectedQualities.get(quality);

        if (format && tunnels.has(format.itag)) {
          targetFormat = format;
          break;
        }
      }
    }

    if (!targetFormat) {
      for (const quality of qualityOrder) {
        const format = selectedQualities.get(quality);

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

    if (!tunnelId) {
      throw new Error("Video tunnel ID was not found.");
    }

    const session = tunnelSessions.get(tunnelId);

    if (!session) {
      throw new Error("Video tunnel session was not found.");
    }

    set.headers["Content-Type"] = "application/json; charset=utf-8";

    return new Response(
      JSON.stringify(
        {
          status: "ok",
          videoId,
          cached: cacheHit,
          title,
          quality: targetFormat.quality_label || normalizedQuality,
          channel,
          thumbnail: bestThumbnail,
          filename: session.filename,
          size: formatBytes(
            getFormatContentLength(targetFormat) +
              getFormatContentLength(bestAudioFormat),
          ),
          expires: formatDuration(TUNNEL_LINK_EXPIRATION_HOURS * 3600),
          infoFetchTime: `${(performance.now() - startTime).toFixed(2)}ms`,
          downloadLink: `${baseUrl}/tunnel/${tunnelId}`,
        },
        null,
        2,
      ),
    );
  }

  const media: MediaInfo[] = [];

  for (const quality of qualityOrder) {
    const format = selectedQualities.get(quality);

    if (!format) {
      continue;
    }

    const tunnelId = tunnels.get(format.itag);
    const session = tunnelId ? tunnelSessions.get(tunnelId) : undefined;

    if (!session || !tunnelId) {
      continue;
    }

    const codec = format.mime_type?.includes("vp9")
      ? "vp9"
      : format.mime_type?.includes("av01")
        ? "av1"
        : "h264";

    media.push({
      quality: format.quality_label,
      size: formatBytes(
        getFormatContentLength(format) +
          getFormatContentLength(bestAudioFormat),
      ),
      codec,
      url: `${baseUrl}/tunnel/${tunnelId}`,
      filename: session.filename,
    });
  }

  const audioSession = tunnelSessions.get(audioTunnelId);

  if (audioSession && query.format?.toLowerCase() !== "mp4") {
    media.push({
      quality: "audio",
      size: formatBytes(getFormatContentLength(bestAudioFormat)),
      codec: bestAudioFormat.mime_type?.includes("mp4a") ? "mp4a" : "opus",
      url: `${baseUrl}/tunnel/${audioTunnelId}`,
      filename: audioSession.filename,
    });
  }

  set.headers["Content-Type"] = "application/json; charset=utf-8";

  return new Response(
    JSON.stringify(
      {
        success: true,
        videoId,
        cached: cacheHit,
        title,
        channel,
        thumbnail: bestThumbnail,
        expires: formatDuration(TUNNEL_LINK_EXPIRATION_HOURS * 3600),
        infoFetchTime: `${(performance.now() - startTime).toFixed(2)}ms`,
        media,
      },
      null,
      2,
    ),
  );
}

const app = new Elysia()
  .use(staticPlugin({ assets: "public", prefix: "", alwaysStatic: true }))
  .onBeforeHandle(({ request, set }) => {
    const ip = getIp(request);

    if (!checkRateLimit(ip)) {
      set.status = 429;
      return {
        status: "error",
        message: "Rate limit exceeded",
      };
    }

    isSpam(request);

    activeRequests++;

    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
  })
  .onAfterHandle(({ response, set }) => {
    activeRequests = Math.max(0, activeRequests - 1);

    if (restartScheduled && activeRequests === 0 && activeOperations === 0) {
      scheduleIdleRestart();
    }

    if (
      typeof response === "object" &&
      response !== null &&
      !(response instanceof Response)
    ) {
      set.headers["Content-Type"] = "application/json; charset=utf-8";
    }
  })
  .onStart(async () => {
    await mkdir(TEMP_DIR_BASE, { recursive: true });
    await mkdir(DOWNLOAD_DIR, { recursive: true });

    setInterval(() => {
      const now = Date.now();

      for (const [id, session] of tunnelSessions.entries()) {
        if (session.expiryTimestamp <= now) {
          tunnelSessions.delete(id);
        }
      }

      for (const [videoId, entry] of videoDataCache.entries()) {
        if (entry.expiryTimestamp <= now) {
          videoDataCache.delete(videoId);
        }
      }

      for (const [cacheKey, entry] of remuxedFileCache.entries()) {
        if (!entry.expiryTimeoutId) {
          void cleanupCachedFile(cacheKey);
        }
      }
    }, 60 * 60 * 1000);

    console.log("API startup complete.");
  })
  .group("/admin", (admin) =>
    admin
      .onBeforeHandle(({ request, set }) => {
        const auth = request.headers.get("Authorization");
        const expected = `Basic ${btoa(`${ADMIN_USER}:${ADMIN_PASS}`)}`;

        if (auth !== expected) {
          set.status = 401;
          return {
            success: false,
            error: "Unauthorized",
          };
        }
      })
      .get("/", () => new Response(Bun.file("public/admin.html")))
      .get("/stats", () => {
        const memory = process.memoryUsage();
        const protection = ProtectionManager.getStats();
        const uptimeHours = Math.floor(process.uptime() / 3600);

        return {
          activeOperations,
          activeRequests,
          memoryUsage: formatBytes(memory.heapUsed),
          blockedCount: protection.blockedCount,
          activeRateLimitedIps: protection.activeRateLimitedIps,
          uptime: `${uptimeHours}h`,
        };
      })
      .post("/block", ({ body, set }: any) => {
        if (!body?.ip) {
          set.status = 400;
          return {
            success: false,
            error: "No IP provided",
          };
        }

        ProtectionManager.blockIp(body.ip);

        return {
          success: true,
          message: "IP blocked",
        };
      })
      .post("/unblock", ({ body, set }: any) => {
        if (!body?.ip) {
          set.status = 400;
          return {
            success: false,
            error: "No IP provided",
          };
        }

        ProtectionManager.unblockIp(body.ip);

        return {
          success: true,
          message: "IP unblocked",
        };
      })
      .post("/clear-cache", async () => {
        const fileEntries = [...remuxedFileCache.entries()];

        for (const [cacheKey] of fileEntries) {
          await cleanupCachedFile(cacheKey);
        }

        const searches = searchCache.size;
        searchCache.clear();
        videoDataCache.clear();

        return {
          success: true,
          message: `Cleared ${fileEntries.length} files and ${searches} search entries.`,
        };
      })
      .post("/restart-timer", () => {
        restartScheduled = true;
        scheduleIdleRestart();

        return {
          success: true,
          message: "Idle restart timer scheduled.",
        };
      }),
  )
  .get("/api/stats", () => getSystemStats())
  .get("/api/ip", async ({ request }) => getIpInfo(getIp(request)))
  .get("/api/device", ({ request }) => getDeviceInfo(request))
  .get(
    "/robots.txt",
    () =>
      new Response(["User-agent: *", "Disallow: /"].join("\n"), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      }),
  )
  .get(
    "/",
    async ({ query, request, set }) => {
      if (!query.url) {
        return new Response(Bun.file("public/home.html"));
      }

      const startTime = performance.now();
      let videoId: string | null = null;

      try {
        videoId = getVideoId(query.url);

        if (!videoId) {
          set.status = 400;
          return {
            success: false,
            error: "Invalid or unsupported YouTube URL provided.",
          };
        }

        return await handleVideoRequest(
          videoId,
          {
            url: query.url,
            quality: query.quality,
            format: query.format,
          },
          request,
          set,
          startTime,
        );
      } catch (error) {
        set.status = 500;

        const payload = {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          name: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString(),
        };

        await Bun.write("./last-error.json", JSON.stringify(payload, null, 2));

        return new Response(JSON.stringify(payload, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
        });
      } finally {
        console.log(
          `[${videoId || "Invalid URL"}] Request processed in ${(
            performance.now() - startTime
          ).toFixed(2)}ms.`,
        );
      }
    },
    {
      query: t.Object({
        url: t.Optional(t.String()),
        quality: t.Optional(t.String()),
        format: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/yt",
    async ({ query, request, set }) => {
      const startTime = performance.now();
      let videoId: string | null = null;

      try {
        videoId = getVideoId(query.url);

        if (!videoId) {
          set.status = 400;
          return {
            success: false,
            error: "Invalid or unsupported YouTube URL provided.",
          };
        }

        return await handleVideoRequest(videoId, query, request, set, startTime);
      } catch (error) {
        set.status = 500;

        const payload = {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          name: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString(),
        };

        await Bun.write("./last-error.json", JSON.stringify(payload, null, 2));

        return new Response(JSON.stringify(payload, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
        });
      } finally {
        console.log(
          `[${videoId || "Invalid URL"}] Request processed in ${(
            performance.now() - startTime
          ).toFixed(2)}ms.`,
        );
      }
    },
    {
      query: t.Object({
        url: t.String(),
        quality: t.Optional(t.String()),
        format: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/pin",
    async ({ query, request, set }) => {
      const clientId = getClientId(request);

      if (query.search) {
        const parsedLimit = Number.parseInt(query.limit || "20", 10);
        const limit = Number.isFinite(parsedLimit)
          ? Math.min(Math.max(parsedLimit, 1), 50)
          : 20;

        const result = await searchPinterest(query.search, clientId, limit);

        if (result.status === "rate_limited") {
          set.status = 429;
          set.headers["Retry-After"] = "60";
        }

        return result;
      }

      if (query.url) {
        const result = await pinHandler(query.url, clientId);

        if (result.status === "rate_limited") {
          set.status = 429;
          set.headers["Retry-After"] = "60";
        }

        return result;
      }

      set.status = 400;

      return {
        status: "error",
        error: "Missing required parameter.",
      };
    },
    {
      query: t.Object({
        url: t.Optional(t.String()),
        search: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .get("/pin/stats", () => getCacheStats())
  .post("/pin/cache/clear", () => {
    clearCaches();

    return {
      status: "success",
      message: "Pinterest cache cleared",
    };
  })
  .get(
    "/insta",
    async ({ query }) => {
      return instaHandler(query.url);
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
      return instav2Handler(query.url);
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
      return fbHandler(query.url);
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
      return ttHandler(query.url);
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
      return xHandler(query.url);
    },
    {
      query: t.Object({
        url: t.String(),
      }),
    },
  )
  .get(
    "/search",
    async ({ query, request, set }) => {
      const startTime = performance.now();

      try {
        const { results, fetchTime, cacheHit } = await getOrFetchSearchResults(
          query.q,
        );

        if (results.length === 0) {
          set.status = 404;

          return {
            success: false,
            error: `No video results found for "${query.q}".`,
          };
        }

        if (query.num) {
          const desired =
            query.num.toLowerCase() === "all"
              ? results
              : results.slice(
                  0,
                  Math.max(1, Number.parseInt(query.num, 10) || 10),
                );

          set.headers["Content-Type"] = "application/json; charset=utf-8";

          return new Response(
            JSON.stringify(
              {
                infoFetchTime: `${fetchTime.toFixed(2)}ms`,
                cache: cacheHit,
                results: desired,
              },
              null,
              2,
            ),
          );
        }

        const videoId = results[0].videoId;

        return await handleVideoRequest(
          videoId,
          {
            url: `https://www.youtube.com/watch?v=${videoId}`,
            quality: query.quality,
            format: query.format,
          },
          request,
          set,
          startTime,
        );
      } catch (error) {
        set.status = 500;

        return {
          success: false,
          error: error instanceof Error ? error.message : "Search failed.",
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

      try {
        const search = await innertube.music.search(query.q, { type: "song" });
        const song = search.songs?.contents.find(
          (item) =>
            (item.item_type === "song" || item.item_type === "video") &&
            typeof item.id === "string",
        );
        const videoId = song?.id;
        if (
          typeof videoId !== "string" ||
          !/^[a-zA-Z0-9_-]{11}$/.test(videoId)
        ) {
          set.status = 404;

          return {
            success: false,
            error: `No song results found for "${query.q}".`,
          };
        }

        return await handleVideoRequest(
          videoId,
          {
            url: `https://www.youtube.com/watch?v=${videoId}`,
            quality: query.quality,
            format: query.format,
          },
          request,
          set,
          startTime,
        );
      } catch (error) {
        set.status = 500;

        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Music search failed.",
        };
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
      const session = tunnelSessions.get(params.tunnelId);

      if (!session || session.expiryTimestamp <= Date.now()) {
        tunnelSessions.delete(params.tunnelId);
        set.status = 404;

        return {
          success: false,
          error: "Download link not found or expired. Please generate a new one.",
        };
      }

      const isAudioOnly = !session.chosenVideoFormat;
      const cacheKey = isAudioOnly
        ? `${session.videoId}-audio-only`
        : `${session.videoId}-${session.itag}`;

      activeOperations++;

      try {
        const cachedFile = await getOrStartDownload(
          session,
          cacheKey,
          isAudioOnly,
        );

        const file = Bun.file(cachedFile.filePath);

        if (!(await file.exists())) {
          remuxedFileCache.delete(cacheKey);
          throw new Error("Generated download file no longer exists.");
        }

        set.headers["Content-Disposition"] = createContentDisposition(
          cachedFile.filename,
        );
        set.headers["Content-Type"] = isAudioOnly ? "audio/mp4" : "video/mp4";
        set.headers["Content-Length"] = file.size.toString();

        console.log(
          `[${cacheKey}] Download prepared in ${(
            performance.now() - startTime
          ).toFixed(2)}ms.`,
        );

        return new Response(file.stream());
      } catch (error) {
        activeDownloads.delete(cacheKey);
        set.status = 500;

        return {
          success: false,
          error: `Failed to process stream: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      } finally {
        activeOperations = Math.max(0, activeOperations - 1);

        if (restartScheduled && activeOperations === 0 && activeRequests === 0) {
          scheduleIdleRestart();
        }
      }
    },
    {
      params: t.Object({
        tunnelId: t.String(),
      }),
    },
  )
  .listen(PORT);

process.on("SIGINT", () => {
  restartScheduled = true;
  void gracefulShutdown("Received SIGINT.");
});

process.on("SIGTERM", () => {
  restartScheduled = true;
  void gracefulShutdown("Received SIGTERM.");
});

console.log(
  `Multi-Format Downloader API is running at http://${app.server?.hostname}:${app.server?.port}`,
);