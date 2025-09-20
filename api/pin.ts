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
        const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
        timings.fetchTime = performance.now() - fetchStartTime;

        if (!response.ok) {
            if (response.status === 404) {
                return { status: 'not_found', timings: { ...timings, totalTime: performance.now() - totalStartTime } };
            }

            throw new Error(`Request failed with status: ${response.status}`);
        }
        const html = await response.text();

        const processStartTime = performance.now();
        const $ = cheerio.load(html);

        let title: string | undefined;
        let author: string | undefined;
        let thumbnail: string | undefined;
        let videoUrl: string | null = null;
        let imageUrl: string | undefined;

        const videoTagSrc = $("video source[src], video[src]").attr("src");
        if (videoTagSrc && videoTagSrc.includes("pinimg.com")) {
            videoUrl = videoTagSrc;
        }

        let ldJsonData: any = null;
        $('script[type="application/ld+json"]').each((_i, el) => {
            try {
                const scriptContent = $(el).html();
                if (scriptContent) {
                    const jsonData = JSON.parse(scriptContent);

                    if (jsonData["@type"] && (jsonData["@type"].includes("Video") || jsonData["@type"].includes("Pin"))) {
                        ldJsonData = jsonData;
                        return false; 
                    }
                }
            } catch (e) {  }
        });

        if (ldJsonData) {

            title = ldJsonData.name || ldJsonData.headline;
            author = ldJsonData.author?.name || ldJsonData.creator?.name;
            thumbnail = ldJsonData.thumbnailUrl || ldJsonData.image;
            imageUrl = ldJsonData.image || ldJsonData.thumbnailUrl;

            if (!videoUrl) {
                videoUrl = ldJsonData.contentUrl || ldJsonData.embedUrl || null;
            }
        } else {

            thumbnail = $('meta[property="og:image"]').attr("content");
            imageUrl = thumbnail; 
            const ogTitle = $('meta[property="og:title"]').attr("content");
            if (ogTitle) {
                title = ogTitle.split('|')[0].trim();
                author = $('meta[property="og:see_also"]').attr("href")?.split('/').filter(Boolean).pop() || undefined;
            }
        }

        if (!title) {
            title = $('div[data-test-id="pinTitle"] h1').text().trim() || undefined;
        }

        if (!videoUrl) {
            $("script").each((_i, el) => {
                const scriptContent = $(el).html();
                if (scriptContent && scriptContent.includes('"video_list"')) {

                    const jsonMatch = scriptContent.match(/"video_list":\{.*?"url":"(.*?)"/s);
                    if (jsonMatch && jsonMatch[1]) {

                        videoUrl = jsonMatch[1].replace(/\\u002F/g, "/");
                        return false; 
                    }
                }
            });
        }

        if (videoUrl && videoUrl.includes(".m3u8")) {
            videoUrl = videoUrl.replace("/hls/", "/expMp4/").replace(".m3u8", "_t1.mp4");
        }

        const media: CleanedMedia[] = [];
        if (videoUrl) {
            media.push({ type: 'video', url: videoUrl });
        } else if (imageUrl) {

            media.push({ type: 'photo', url: imageUrl });
        }

        timings.processTime = performance.now() - processStartTime;
        timings.totalTime = performance.now() - totalStartTime;

        if (media.length === 0) {

            return { status: 'not_found', timings };
        }

        return {
            status: 'success',
            author: author?.trim(),
            title: title?.trim(),
            thumbnail: thumbnail?.trim(),
            media,
            timings
        };

    } catch (error: any) {
        console.error("[Pinterest Scraper Error]", error.message);
        timings.totalTime = performance.now() - totalStartTime;
        return { status: 'fetch_error', timings };
    }
}

export default async function handler(url: string) {
  return await scrapePinterest(url);
}
