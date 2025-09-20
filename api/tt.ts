import { performance } from 'perf_hooks';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { createServer } from 'http';
import { Server } from 'socket.io';

const TIKTOK_BASE_URL = "https://www.tiktok.com";
const GENERIC_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Video cache directory
const CACHE_DIR = join(process.cwd(), '.tiktok-cache');
if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
}

// Streaming server state
let streamingServer: any = null;
const activeStreams = new Map<string, string>();

type CleanedMedia = {
    type: 'video' | 'photo' | 'audio';
    url: string;
    streamUrl?: string; // Added stream URL for IP-locked videos
};

export type ExtractionResult = {
    status: 'success' | 'not_found' | 'fetch_error' | 'invalid_url' | 'processing';
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
    message?: string;
};

function getPostId(url: string): string | null {
    const match = url.match(/(?:video|photo)\/(\d+)/);
    return match ? match[1] : null;
}

async function fetchAndParsePage(postId: string): Promise<{ jsonData: any, cookieString: string }> {
    const scraperUrl = `${TIKTOK_BASE_URL}/@i/video/${postId}`;
    
    const response = await axios.get(scraperUrl, {
        headers: { 
            "User-Agent": GENERIC_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
        },
        timeout: 10000
    });

    const cookies = response.headers['set-cookie'] || [];
    const cookieString = cookies.map((cookie: string) => cookie.split(';')[0]).join('; ');
    
    const html = response.data;
    const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    const jsonString = match ? match[1] : null;

    if (!jsonString) {
        throw new Error("Could not find __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON data in the response.");
    }
    
    return { jsonData: JSON.parse(jsonString), cookieString };
}

async function downloadVideo(videoUrl: string, postId: string): Promise<string> {
    const cachePath = join(CACHE_DIR, `${postId}.mp4`);
    
    // Return cached video if exists
    if (existsSync(cachePath)) {
        return cachePath;
    }

    console.log(`[TikTok] Downloading video: ${videoUrl}`);
    
    const response = await axios({
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        headers: {
            'User-Agent': GENERIC_USER_AGENT,
            'Referer': 'https://www.tiktok.com/',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Range': 'bytes=0-',
            'Sec-Fetch-Dest': 'video',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'same-site',
        },
        timeout: 30000
    });

    const writer = createWriteStream(cachePath);
    response.data.pipe(writer);
    
    await finished(writer);
    console.log(`[TikTok] Video downloaded: ${cachePath}`);
    
    return cachePath;
}

function startStreamingServer(): Promise<string> {
    return new Promise((resolve) => {
        if (streamingServer) {
            resolve(`http://localhost:3001`);
            return;
        }

        streamingServer = createServer((req, res) => {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            const videoPath = url.pathname.replace('/stream/', '');
            
            if (activeStreams.has(videoPath)) {
                const filePath = activeStreams.get(videoPath);
                if (filePath && existsSync(filePath)) {
                    res.writeHead(200, {
                        'Content-Type': 'video/mp4',
                        'Content-Length': readFileSync(filePath).length,
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type',
                    });
                    
                    const readStream = createReadStream(filePath);
                    readStream.pipe(res);
                    
                    readStream.on('error', (err) => {
                        console.error('Stream error:', err);
                        res.writeHead(500);
                        res.end('Stream error');
                    });
                    
                    return;
                }
            }
            
            res.writeHead(404);
            res.end('Video not found');
        });

        streamingServer.listen(3001, () => {
            console.log('[TikTok] Streaming server started on port 3001');
            resolve(`http://localhost:3001`);
        });

        streamingServer.on('error', (err: Error) => {
            console.error('Streaming server error:', err);
        });
    });
}

function createReadStream(path: string): Readable {
    const stream = new Readable();
    stream._read = () => {};
    
    try {
        const data = readFileSync(path);
        stream.push(data);
        stream.push(null);
    } catch (error) {
        stream.emit('error', error);
    }
    
    return stream;
}

async function createStreamableUrl(videoUrl: string, postId: string): Promise<string> {
    try {
        // Download the video first
        const localPath = await downloadVideo(videoUrl, postId);
        
        // Start streaming server if not running
        const baseUrl = await startStreamingServer();
        
        // Register this video with the streaming server
        const streamId = `${postId}.mp4`;
        activeStreams.set(streamId, localPath);
        
        return `${baseUrl}/stream/${streamId}`;
    } catch (error) {
        console.error('[TikTok] Failed to create streamable URL:', error);
        throw error;
    }
}

async function isVideoIpLocked(videoUrl: string): Promise<boolean> {
    try {
        const response = await axios.head(videoUrl, {
            headers: {
                'User-Agent': GENERIC_USER_AGENT,
                'Range': 'bytes=0-1' // Just check first few bytes
            },
            timeout: 5000
        });
        
        // If we get a 403, it's likely IP locked
        return response.status === 403;
    } catch (error: any) {
        return error.response?.status === 403;
    }
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
                const response = await axios.head(initialUrl, {
                    headers: { 'User-Agent': GENERIC_USER_AGENT },
                    maxRedirects: 5,
                    timeout: 10000
                });
                resolvedUrl = response.request.res.responseUrl || initialUrl;
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
            // Handle image posts
            thumbnail = itemStruct.imagePost.images[0]?.imageURL?.urlList?.[0];
            for (const image of itemStruct.imagePost.images) {
                const imageUrl = image?.imageURL?.urlList?.[0];
                if (imageUrl) mediaUrls.push({ type: 'photo', url: imageUrl });
            }
            const audioUrl = itemStruct.music?.playUrl;
            if (audioUrl) mediaUrls.push({ type: 'audio', url: audioUrl });
        } else if (itemStruct.video?.playAddr) {
            // Handle video posts
            thumbnail = itemStruct.video.cover;
            const videoUrl = itemStruct.video.playAddr;
            
            // Check if video is IP locked
            const isLocked = await isVideoIpLocked(videoUrl);
            
            if (isLocked) {
                console.log('[TikTok] Video is IP locked, creating streamable URL...');
                try {
                    const streamUrl = await createStreamableUrl(videoUrl, postId);
                    mediaUrls.push({ 
                        type: 'video', 
                        url: videoUrl,
                        streamUrl: streamUrl
                    });
                } catch (error) {
                    console.error('[TikTok] Failed to create streamable URL:', error);
                    // Fallback to original URL
                    mediaUrls.push({ type: 'video', url: videoUrl });
                }
            } else {
                mediaUrls.push({ type: 'video', url: videoUrl });
            }
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

// Cleanup function to remove old cached videos
function cleanupCache(maxAgeHours: number = 24) {
    const files = readdirSync(CACHE_DIR);
    const now = Date.now();
    
    files.forEach(file => {
        const filePath = join(CACHE_DIR, file);
        const stats = statSync(filePath);
        const ageHours = (now - stats.mtimeMs) / (1000 * 60 * 60);
        
        if (ageHours > maxAgeHours) {
            unlinkSync(filePath);
            console.log(`[TikTok] Removed old cache file: ${file}`);
        }
    });
}

// Run cleanup every hour
setInterval(() => cleanupCache(24), 60 * 60 * 1000);

export default async function handler(url: string) {
    return await scrapeTikTok(url);
}