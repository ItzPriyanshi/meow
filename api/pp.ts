import { Elysia, t } from 'elysia';
import axios from 'axios';
import * as crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const PROXY_LIST = [
    'http://user:pass@192.168.1.100:8080',
    'socks5://user:pass@127.0.0.1:9050',
    'http://45.76.102.33:3128',
    'http://103.145.133.22:8080',
    'socks5://138.197.157.44:1080'
];

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
];

const generateFingerprint = () => {
    return {
        canvas: crypto.createHash('md5').update(Math.random().toString()).digest('hex'),
        webgl: crypto.createHash('sha256').update(Math.random().toString()).digest('hex')
    };
};

const HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://picsart.com",
    "Referer": "https://picsart.com/",
    "DNT": "1",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "X-Requested-With": "XMLHttpRequest"
};

const generateSessionToken = () => {
    return crypto.randomBytes(32).toString('hex') + Date.now();
};

const createProxyAgent = (proxyUrl: string) => {
    if (proxyUrl.startsWith('socks')) {
        return new SocksProxyAgent(proxyUrl);
    } else {
        return new HttpsProxyAgent(proxyUrl);
    }
};

class PicsArtUpscaleBypass {
    private sessionToken: string;
    private proxyIndex: number;
    private requestCount: number;
    private workingProxies: string[];

    constructor() {
        this.sessionToken = generateSessionToken();
        this.proxyIndex = 0;
        this.requestCount = 0;
        this.workingProxies = [...PROXY_LIST];
    }

    private rotateProxy(): string {
        this.proxyIndex = (this.proxyIndex + 1) % this.workingProxies.length;
        return this.workingProxies[this.proxyIndex];
    }

    private rotateUserAgent(): string {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    private markProxyDead(proxyUrl: string) {
        this.workingProxies = this.workingProxies.filter(p => p !== proxyUrl);
        if (this.workingProxies.length === 0) {
            this.workingProxies = [...PROXY_LIST];
        }
    }

    private async makeRequest(url: string, data?: any) {
        const proxyUrl = this.rotateProxy();
        const agent = createProxyAgent(proxyUrl);

        const config: any = {
            method: data ? 'post' : 'get',
            url: url,
            headers: {
                ...HEADERS,
                "User-Agent": this.rotateUserAgent(),
                "X-Session-Token": this.sessionToken,
                "X-Client-Timestamp": Date.now().toString(),
                "X-Client-Fingerprint": generateFingerprint().canvas
            },
            timeout: 15000,
            validateStatus: () => true,
            httpsAgent: agent,
            httpAgent: agent
        };

        if (data) {
            config.data = data;
            config.headers['Content-Type'] = 'application/json';
        }

        this.requestCount++;
        
        if (this.requestCount % 5 === 0) {
            this.sessionToken = generateSessionToken();
        }

        try {
            const response = await axios(config);
            return response;
        } catch (error) {
            this.markProxyDead(proxyUrl);
            throw error;
        }
    }

    private async bypassRateLimit() {
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 2000) + 1000));
    }

    async upscaleImage(imageUrl: string): Promise<any> {
        try {
            await this.bypassRateLimit();

            const initResponse = await this.makeRequest(
                'https://api.picsart.com/tools/1.0/upscale/init',
                { image_url: imageUrl }
            );

            if (initResponse.status === 429) {
                return { status: 'rate_limited' };
            }

            if (initResponse.status !== 200) {
                return { status: 'api_error' };
            }

            const taskId = initResponse.data.data.task_id;
            
            let upscaleResult: any = null;
            let retries = 0;

            while (retries < 10 && !upscaleResult) {
                await this.bypassRateLimit();
                
                const statusResponse = await this.makeRequest(
                    `https://api.picsart.com/tools/1.0/upscale/status/${taskId}`
                );

                if (statusResponse.status === 200 && statusResponse.data.data.status === 'completed') {
                    upscaleResult = statusResponse.data.data;
                    break;
                }

                if (statusResponse.status === 429) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }

                retries++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            if (!upscaleResult) {
                return { status: 'processing_failed' };
            }

            return {
                status: 'success',
                originalUrl: imageUrl,
                upscaledUrl: upscaleResult.result_url,
                resolution: upscaleResult.resolution,
                fileSize: upscaleResult.file_size
            };

        } catch (error: any) {
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                return { status: 'proxy_dead' };
            }

            if (error.response?.status === 429) {
                return { status: 'rate_limited' };
            }

            return { status: 'api_error' };
        }
    }
}

export async function scrapePicsArtUpscale(url: string) {
    try {
        const scraper = new PicsArtUpscaleBypass();
        const result = await scraper.upscaleImage(url);
        
        return {
            status: result.status,
            original_url: result.originalUrl,
            upscaled_url: result.upscaledUrl,
            resolution: result.resolution,
            file_size: result.fileSize
        };
    } catch (error: any) {
        return {
            status: 'error',
            message: error.message
        };
    }
}

export default async function handler(url: string) {
    return await scrapePicsArtUpscale(url);
}

export const ppRoute = new Elysia()
    .get('/pp', async ({ query, set }) => {
        const { url } = query;
        
        if (!url) {
            set.status = 400;
            return {
                status: 'error',
                message: 'Missing URL parameter. Use ?url=your_image_url'
            };
        }

        try {
            const result = await handler(url);
            
            if (result.status === 'success') {
                return {
                    status: 'success',
                    data: {
                        original_url: result.original_url,
                        upscaled_url: result.upscaled_url,
                        resolution: result.resolution,
                        file_size: result.file_size,
                        download_link: result.upscaled_url
                    }
                };
            } else {
                set.status = 500;
                return {
                    status: 'error',
                    message: result.status,
                    details: result
                };
            }
        } catch (error: any) {
            set.status = 500;
            return {
                status: 'error',
                message: error.message
            };
        }
    }, {
        query: t.Object({
            url: t.String()
        })
    });