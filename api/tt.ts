import { performance } from 'perf_hooks';
import fetch from 'node-fetch';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'cheerio';

const TIKTOK_BASE_URL = "https://www.tiktok.com";
const GENERIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

type CleanedMedia = { type: 'video' | 'photo' | 'audio'; url: string; };

export type ExtractionResult = {
  status: 'success' | 'not_found' | 'fetch_error' | 'invalid_url';
  author?: string;
  title?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  timings: {
    fetchTime: number;
    processTime: number;
    totalTime: number;
  };
  cookieString?: string;
  postId?: string;
};

// Extract post ID from TikTok URL
function getPostId(url: string): string | null {
  const match = url.match(/\/(?:video|photo)\/(\d+)/);
  return match ? match[1] : null;
}

// Fetch TikTok page and extract JSON metadata
async function fetchTikTokPage(postId: string): Promise<{ jsonData: any; cookieString: string }> {
  const scraperUrl = `${TIKTOK_BASE_URL}/@i/video/${postId}`;
  const start = performance.now();

  const res = await fetch(scraperUrl, { headers: { "User-Agent": GENERIC_USER_AGENT } });
  if (!res.ok) throw new Error(`Failed to fetch video page: ${res.status} ${res.statusText}`);

  const cookieString = res.headers.get('set-cookie') || '';
  const html = await res.text();

  // Extract JSON from <script id="SIGI_STATE">
  const $ = cheerio.load(html);
  const script = $('#SIGI_STATE').html();
  if (!script) throw new Error('Unable to extract TikTok metadata.');
  const jsonData = JSON.parse(script);

  return { jsonData, cookieString };
}

// Download media to temp folder
async function downloadMedia(url: string, postId: string): Promise<string> {
  const tempDir = join(process.cwd(), 'temp');
  await mkdir(tempDir, { recursive: true });

  const res = await fetch(url, { headers: { 'User-Agent': GENERIC_USER_AGENT } });
  if (!res.ok) throw new Error(`Failed to download media: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const filePath = join(tempDir, `${postId}.mp4`);
  await writeFile(filePath, buffer);
  return filePath;
}

// Main scraping function
async function scrapeTikTok(initialUrl: string): Promise<ExtractionResult> {
  const totalStartTime = performance.now();
  const postId = getPostId(initialUrl);
  if (!postId)
    return {
      status: 'invalid_url',
      timings: { fetchTime: 0, processTime: 0, totalTime: 0 }
    };

  let fetchTime = 0,
    processTime = 0;

  try {
    const startFetch = performance.now();
    const { jsonData, cookieString } = await fetchTikTokPage(postId);
    fetchTime = performance.now() - startFetch;

    const startProcess = performance.now();
    const videoData = jsonData.ItemModule[postId];
    if (!videoData)
      return {
        status: 'not_found',
        timings: { fetchTime, processTime: 0, totalTime: performance.now() - totalStartTime }
      };

    const mediaUrl = videoData.video?.playAddr || videoData.video?.downloadAddr;
    if (!mediaUrl) throw new Error('Video URL not found in metadata.');

    const downloadedFile = await downloadMedia(mediaUrl, postId);
    processTime = performance.now() - startProcess;

    return {
      status: 'success',
      author: videoData.author,
      title: videoData.desc,
      thumbnail: videoData.video?.cover,
      media: [{ type: 'video', url: downloadedFile }],
      cookieString,
      postId,
      timings: {
        fetchTime,
        processTime,
        totalTime: performance.now() - totalStartTime
      }
    };
  } catch (err: any) {
    return {
      status: 'fetch_error',
      timings: {
        fetchTime,
        processTime,
        totalTime: performance.now() - totalStartTime
      }
    };
  }
}

// Exported handler for index.ts
export default async function handler(url: string) {
  return await scrapeTikTok(url);
}