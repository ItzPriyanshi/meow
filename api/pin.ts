import { performance } from 'perf_hooks';
import * as cheerio from 'cheerio/slim';

type CleanedMedia = {
    type: 'video' | 'photo';
    url: string;
};

export type ExtractionResult = {
    status: 'success' | 'not_found' | 'fetch_error';
    author?: string;
    title?: string;
    thumbnail?: string;
    media?: CleanedMedia[];
    timings: { fetchTime: number; processTime: number; totalTime: number; };
};

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function scrapePinterest(url: string): Promise<ExtractionResult> {
    const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
    const totalStartTime = performance.now();

    try {
        const fetchStartTime = performance.now();
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
        timings.fetchTime = performance.now() - fetchStartTime;

        if (!res.ok) {
            if (res.status === 404) return { status: 'not_found', timings: { ...timings, totalTime: performance.now() - totalStartTime } };
            throw new Error(`Request failed with status: ${res.status}`);
        }

        const html = await res.text();
        const processStartTime = performance.now();
        const $ = cheerio.load(html);

        let title = $('meta[property="og:title"]').attr("content") || $('title').text().trim();
        let author = $('meta[name="author"]').attr("content");
        let thumbnail = $('meta[property="og:image"]').attr("content");

        const media: CleanedMedia[] = [];

        // Try video via HTML first
        const videoTag = $("video source[src], video[src]").attr("src");
        if (videoTag) media.push({ type: 'video', url: videoTag });

        // Fallback to JSON API for protected videos/images
        const pinIdMatch = url.match(/pin\/(\d+)/);
        if (pinIdMatch) {
            const pinId = pinIdMatch[1];
            const apiRes = await fetch(`https://www.pinterest.com/pin/${pinId}/?format=json`, {
                headers: {
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "X-Requested-With": "XMLHttpRequest"
                }
            });

            if (apiRes.ok) {
                const jsonText = await apiRes.text();
                const cleanJson = jsonText.replace(/^for\(;;\);/, '');
                const data = JSON.parse(cleanJson);
                const pinData = Object.values(data?.props?.initialReduxState?.pins || {})[0];

                if (pinData) {
                    title = title || pinData.title || pinData.description;
                    author = author || pinData.pinner?.username || pinData.pinner?.full_name;
                    thumbnail = thumbnail || pinData.images?.orig?.url;

                    if (pinData.videos?.video_list) {
                        const bestVideo = Object.values(pinData.videos.video_list).sort((a: any, b: any) => b.height - a.height)[0];
                        if (bestVideo?.url) media.push({ type: 'video', url: bestVideo.url });
                    } else if (pinData.images?.orig?.url && media.length === 0) {
                        media.push({ type: 'photo', url: pinData.images.orig.url });
                    }
                }
            }
        }

        timings.processTime = performance.now() - processStartTime;
        timings.totalTime = performance.now() - totalStartTime;

        if (media.length === 0) return { status: 'not_found', timings };

        return { status: 'success', author: author?.trim(), title: title?.trim(), thumbnail: thumbnail?.trim(), media, timings };

    } catch (err: any) {
        console.error("[Pinterest Scraper Error]", err.message);
        timings.totalTime = performance.now() - totalStartTime;
        return { status: 'fetch_error', timings };
    }
}

export default async function handler(url: string) {
    return await scrapePinterest(url);
}