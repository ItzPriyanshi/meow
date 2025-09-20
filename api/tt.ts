import { performance } from 'perf_hooks';

const TIKTOK_BASE_URL = "https://www.tiktok.com";
const GENERIC_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

type CleanedMedia = {
    type: 'video' | 'photo' | 'audio';
    url: string;
};

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

function getPostId(url: string): string | null {
    const match = url.match(/(?:video|photo)\/(\d+)/);
    return match ? match[1] : null;
}

async function fetchAndParsePage(postId: string): Promise<{ jsonData: any, cookieString: string }> {
    const scraperUrl = `${TIKTOK_BASE_URL}/@i/video/${postId}`;
    const response = await fetch(scraperUrl, { headers: { "User-Agent": GENERIC_USER_AGENT } });
    if (!response.ok) {
        throw new Error(`Failed to fetch video page: ${response.status} ${response.statusText}`);
    }

    const cookies = response.headers.getSetCookie();
    const cookieString = cookies.map(cookie => cookie.split(';')[0]).join('; ');
    const html = await response.text();

    const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    const jsonString = match ? match[1] : null;

    if (!jsonString) {
        throw new Error("Could not find __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON data in the response.");
    }
    return { jsonData: JSON.parse(jsonString), cookieString };
}

export async function scrapeTikTok(initialUrl: string): Promise<ExtractionResult> {
    const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
    const totalStartTime = performance.now();
    let resolvedUrl = initialUrl;

    try {
        let postId = getPostId(initialUrl);

        if (!postId) {
            console.log(`[TikTok] Resolving short URL: ${initialUrl}`);
            const fetchStartTime = performance.now();
            try {
                const response = await fetch(initialUrl, {
                    method: 'HEAD',
                    redirect: 'follow',
                    headers: { 'User-Agent': GENERIC_USER_AGENT }
                });
                resolvedUrl = response.url;
                timings.fetchTime += performance.now() - fetchStartTime;
                console.log(`[TikTok] Resolved to: ${resolvedUrl}`);
                postId = getPostId(resolvedUrl);
            } catch (e: any) {
                timings.totalTime = performance.now() - totalStartTime;
                return { status: 'invalid_url', timings };
            }
        }

        if (!postId) {
            timings.totalTime = performance.now() - totalStartTime;
            return { status: 'invalid_url', timings };
        }

        const pageFetchStartTime = performance.now();
        const { jsonData: jsonResponse, cookieString } = await fetchAndParsePage(postId);
        timings.fetchTime += performance.now() - pageFetchStartTime;

        const processStartTime = performance.now();
        const videoDetail = jsonResponse?.__DEFAULT_SCOPE__?.["webapp.video-detail"];

        if (!videoDetail || videoDetail.statusMsg || !videoDetail.itemInfo?.itemStruct) {
            timings.totalTime = performance.now() - totalStartTime;
            return { status: 'not_found', timings };
        }

        const itemStruct = videoDetail.itemInfo.itemStruct;
        const author = itemStruct.author?.uniqueId || 'unknown_author';
        const title = itemStruct.desc || '';
        const mediaUrls: CleanedMedia[] = [];
        let thumbnail: string | undefined;

        if (itemStruct.imagePost?.images) {
            thumbnail = itemStruct.imagePost.images[0]?.imageURL?.urlList?.[0];
            for (const image of itemStruct.imagePost.images) {
                const imageUrl = image?.imageURL?.urlList?.[0];
                if (imageUrl) mediaUrls.push({ type: 'photo', url: imageUrl });
            }
            const audioUrl = itemStruct.music?.playUrl;
            if (audioUrl) mediaUrls.push({ type: 'audio', url: audioUrl });
        } else if (itemStruct.video?.playAddr) {
            thumbnail = itemStruct.video.cover;
            mediaUrls.push({ type: 'video', url: itemStruct.video.playAddr });
        }

        timings.processTime = performance.now() - processStartTime;
        timings.totalTime = performance.now() - totalStartTime;

        if (mediaUrls.length > 0) {
            return {
                status: 'success',
                author,
                title,
                thumbnail,
                media: mediaUrls,
                timings,
                cookieString,
                postId,
            };
        } else {
            return { status: 'not_found', timings };
        }

    } catch (error: any) {
        console.error("[TikTok Scraper Error]", error.message);
        timings.totalTime = performance.now() - totalStartTime;
        return { status: 'fetch_error', timings };
    }
}

export default async function handler(url: string) {
    return await scrapeTikTok(url);
}
