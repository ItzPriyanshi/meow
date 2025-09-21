import axios from 'axios';
import * as cheerio from 'cheerio/slim';
import { performance } from 'perf_hooks';

type CleanedMedia = {
  type: 'video' | 'photo';
  url: string;
};

export type ExtractionResult = {
  status: 'success' | 'not_found' | 'fetch_error' | 'access_denied';
  author?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  timings: { fetchTime: number; processTime: number; totalTime: number };
};

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.tiktok.com/",
  "DNT": "1",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="126"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
];

export async function scrapeTikTok(url: string): Promise<ExtractionResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  try {
    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const headers = { ...HEADERS, "User-Agent": randomUserAgent };

    const fetchStartTime = performance.now();
    const response = await axios.get(url, {
      headers,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
      decompress: true,
    });
    timings.fetchTime = performance.now() - fetchStartTime;

    if (response.status === 403 || response.data.includes("Access Denied")) {
      return { status: 'access_denied', timings };
    }

    const html = response.data;
    const processStartTime = performance.now();
    const $ = cheerio.load(html);

    let title: string | undefined;
    let author: string | undefined;
    let description: string | undefined;
    let thumbnail: string | undefined;
    let videoUrl: string | null = null;

    // Method 1: JSON-LD metadata
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const scriptContent = $(el).html();
        if (scriptContent) {
          const data = JSON.parse(scriptContent);
          if (data["@type"] === "VideoObject") {
            title = data.name || data.headline;
            author = data.author?.name || data.creator?.name;
            description = data.description;
            thumbnail = data.thumbnailUrl;
            videoUrl = data.contentUrl || data.embedUrl || null;
          }
        }
      } catch {}
    });

    // Method 2: TikTok embedded JSON
    if (!videoUrl) {
      $('script[id="SIGI_STATE"]').each((_i, el) => {
        try {
          const scriptContent = $(el).html();
          if (scriptContent) {
            const data = JSON.parse(scriptContent);
            const itemModule = data.ItemModule ? Object.values(data.ItemModule)[0] : null;
            if (itemModule) {
              title = title || itemModule.desc;
              author = author || itemModule.author;
              thumbnail = thumbnail || itemModule.video?.cover;
              videoUrl = videoUrl || itemModule.video?.downloadAddr || itemModule.video?.playAddr;
            }
          }
        } catch {}
      });
    }

    // Method 3: Fallback to meta tags
    if (!title) title = $('meta[property="og:title"]').attr("content");
    if (!description) description = $('meta[property="og:description"]').attr("content");
    if (!thumbnail) thumbnail = $('meta[property="og:image"]').attr("content");
    if (!videoUrl) videoUrl = $('meta[property="og:video"]').attr("content");

    const cleanUrl = (u: string | undefined) => (u ? u.replace(/\\\//g, '/').trim() : undefined);

    const media: CleanedMedia[] = [];
    if (videoUrl) {
      media.push({ type: 'video', url: cleanUrl(videoUrl)! });
    }

    timings.processTime = performance.now() - processStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    if (media.length === 0) return { status: 'not_found', timings };

    return {
      status: 'success',
      author: author?.trim(),
      title: title?.trim(),
      description: description?.trim(),
      thumbnail: cleanUrl(thumbnail),
      media,
      timings,
    };
  } catch (error: any) {
    console.error("[TikTok Scraper Error]", error.message);
    if (error.response?.status === 403 || error.response?.status === 401) {
      return { status: 'access_denied', timings };
    }
    timings.totalTime = performance.now() - totalStartTime;
    return { status: 'fetch_error', timings };
  }
}

export default async function handler(url: string) {
  return await scrapeTikTok(url);
}