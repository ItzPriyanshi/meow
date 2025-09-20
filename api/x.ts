import { performance } from 'perf_hooks';

const commonHeaders = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
};

type CleanedMedia = {
    type: 'video' | 'photo' | 'gif';
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
    error?: string;
};

function getTweetId(url: string): string | null {
    const match = url.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
}

const generateSyndicationToken = (id: string): string => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/0+|\./g, '');

async function requestSyndicationTweet(tweetId: string): Promise<any | undefined> {
    const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${generateSyndicationToken(tweetId)}&lang=en`;
    try {
        const response = await fetch(syndicationUrl, {
            headers: {
                "user-agent": commonHeaders["user-agent"]
            },
        });
        if (response.ok) return await response.json();
    } catch (e: any) {
        console.error("Error requesting tweet via Syndication:", e.message);
    }
    return undefined;
}

function bestQualityVideo(variants: any[]): string | undefined {
    if (!variants || variants.length === 0) return undefined;
    let bestVariant: any = null;
    let maxBitrate = -1;
    for (const variant of variants) {
        if (variant.content_type === "video/mp4" && variant.url) {
            const bitrate = variant.bitrate || 0;
            if (bitrate > maxBitrate) {
                maxBitrate = bitrate;
                bestVariant = variant;
            }
        }
    }
    return bestVariant?.url;
}

export async function scrapeTwitter(url: string): Promise<ExtractionResult> {
    const totalStartTime = performance.now();
    let fetchTime = 0;
    let processTime = 0;
    const tweetId = getTweetId(url);
    if (!tweetId) {
        const totalTime = performance.now() - totalStartTime;
        return { status: 'invalid_url', error: "Invalid Twitter/X URL provided.", timings: { fetchTime, processTime, totalTime } };
    }
    try {
        const fetchStartTime = performance.now();
        const tweetData = await requestSyndicationTweet(tweetId);
        fetchTime = performance.now() - fetchStartTime;

        const processStartTime = performance.now();
        if (!tweetData || Object.keys(tweetData).length === 0) {
            const totalTime = performance.now() - totalStartTime;
            return { status: 'not_found', error: "Could not find tweet. It may be private, deleted, or from a suspended account.", timings: { fetchTime, processTime, totalTime } };
        }

        const media: CleanedMedia[] = [];
        const tweetMedia = tweetData.mediaDetails;
        if (tweetMedia?.length > 0) {
            for (const item of tweetMedia) {
                if (item.type === 'animated_gif') {
                    const videoUrl = bestQualityVideo(item.video_info?.variants);
                    if (videoUrl) media.push({ type: 'gif', url: videoUrl });
                } else if (item.type === 'video') {
                    const videoUrl = bestQualityVideo(item.video_info?.variants);
                    if (videoUrl) media.push({ type: 'video', url: videoUrl });
                } else if (item.type === 'photo') {
                    media.push({ type: 'photo', url: item.media_url_https });
                }
            }
        }

        if (media.length === 0) {
            const totalTime = performance.now() - totalStartTime;
            return { status: 'not_found', error: "No downloadable media found in this tweet.", timings: { fetchTime, processTime, totalTime } };
        }

        let title = tweetData.text || 'Untitled Tweet';
        const mediaUrlToRemove = tweetData.entities?.media?.[0]?.url;
        if (mediaUrlToRemove) {
            title = title.replace(mediaUrlToRemove, '').trim();
        }

        processTime = performance.now() - processStartTime;
        const totalTime = performance.now() - totalStartTime;

        return {
            status: 'success',
            author: tweetData.user?.screen_name,
            title,
            thumbnail: tweetMedia[0]?.media_url_https,
            media,
            timings: { fetchTime, processTime, totalTime }
        };

    } catch (error: any) {
        console.error("An unexpected error occurred during Twitter scraping:", error.message);
        const totalTime = performance.now() - totalStartTime;
        return { status: 'fetch_error', error: "An internal server error occurred while fetching data.", timings: { fetchTime, processTime, totalTime } };
    }
}

export default async function handler(url: string) {
    return await scrapeTwitter(url);
}
