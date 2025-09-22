import axios from 'axios';
import * as cheerio from 'cheerio/slim';
import { performance } from 'perf_hooks';
import * as crypto from 'crypto';

type UpscaleResult = {
  status: 'success' | 'not_found' | 'fetch_error' | 'access_denied' | 'processing' | 'quota_exceeded';
  original_url?: string;
  upscaled_url?: string;
  job_id?: string;
  progress?: number;
  error_message?: string;
  timings: {
    fetchTime: number;
    processTime: number;
    totalTime: number;
  };
};

// Advanced browser fingerprinting headers
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Referer": "https://picsart.com/",
  "Origin": "https://picsart.com",
  "DNT": "1",
  "Connection": "keep-alive",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "Sec-Ch-Ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Cache-Control": "no-cache",
  "Pragma": "no-cache"
};

// Rotating user agents for anti-detection
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
];

// Device fingerprint generation
function generateDeviceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

// Generate realistic timestamps
function generateTimestamp(): number {
  return Date.now() - Math.floor(Math.random() * 300000); // Random time within last 5 minutes
}

// Advanced cookie generation
function generateSessionCookies(): string {
  const deviceId = generateDeviceId();
  const sessionId = generateSessionId();
  const timestamp = generateTimestamp();
  
  return [
    `device_id=${deviceId}`,
    `session_id=${sessionId}`,
    `timestamp=${timestamp}`,
    `user_consent=accepted`,
    `csrf_token=${crypto.randomBytes(32).toString('hex')}`,
    `visit_count=${Math.floor(Math.random() * 50) + 1}`,
    `last_activity=${Date.now()}`,
    `browser_fingerprint=${Buffer.from(JSON.stringify({
      screen: { width: 1920, height: 1080, colorDepth: 24 },
      timezone: 'America/New_York',
      language: 'en-US',
      platform: 'Win32',
      cookieEnabled: true,
      doNotTrack: '1'
    })).toString('base64')}`
  ].join('; ');
}

// Proxy rotation support
const PROXY_LIST = [
  // Add your proxy endpoints here
  // 'http://proxy1:port',
  // 'http://proxy2:port'
];

function getRandomProxy(): string | undefined {
  if (PROXY_LIST.length === 0) return undefined;
  return PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
}

// Rate limiting bypass with exponential backoff
class RateLimiter {
  private requests: number[] = [];
  private readonly maxRequests = 10;
  private readonly timeWindow = 60000; // 1 minute

  async checkLimit(): Promise<void> {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < this.timeWindow);
    
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = Math.min(...this.requests);
      const waitTime = this.timeWindow - (now - oldestRequest);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.requests.push(now);
  }
}

const rateLimiter = new RateLimiter();

// Main scraper function
export async function scrapePicsArtUpscale(imageUrl: string, scale: number = 2): Promise<UpscaleResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  try {
    await rateLimiter.checkLimit();

    // Rotate user agent and generate fresh session
    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const sessionCookies = generateSessionCookies();
    const proxy = getRandomProxy();
    
    const headers = {
      ...HEADERS,
      "User-Agent": randomUserAgent,
      "Cookie": sessionCookies,
      "X-Device-Id": generateDeviceId(),
      "X-Session-Id": generateSessionId(),
      "X-Request-Id": crypto.randomUUID(),
      "X-Timestamp": Date.now().toString()
    };

    const axiosConfig: any = {
      headers,
      timeout: 30000,
      maxRedirects: 3,
      validateStatus: (status: number) => status < 500,
    };

    if (proxy) {
      axiosConfig.proxy = {
        protocol: 'http',
        host: proxy.split('://')[1].split(':')[0],
        port: parseInt(proxy.split(':')[2])
      };
    }

    const fetchStartTime = performance.now();

    // Step 1: Get initial page to extract tokens
    const initialResponse = await axios.get('https://picsart.com/upscale', axiosConfig);
    
    if (initialResponse.status !== 200) {
      return {
        status: 'access_denied',
        error_message: `Initial page load failed: ${initialResponse.status}`,
        timings: { fetchTime: 0, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    const $ = cheerio.load(initialResponse.data);
    
    // Extract CSRF token and other necessary data
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || 
                     $('input[name="_token"]').attr('value') ||
                     crypto.randomBytes(32).toString('hex');

    // Step 2: Submit upscale request
    const uploadData = {
      image_url: imageUrl,
      scale_factor: scale,
      output_format: 'png',
      enhance_quality: true,
      preserve_transparency: true,
      _token: csrfToken,
      device_id: generateDeviceId(),
      session_id: generateSessionId()
    };

    const uploadHeaders = {
      ...headers,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      "X-Requested-With": "XMLHttpRequest"
    };

    const uploadResponse = await axios.post(
      'https://api.picsart.com/tools/1.0/upscale',
      uploadData,
      { ...axiosConfig, headers: uploadHeaders }
    );

    timings.fetchTime = performance.now() - fetchStartTime;
    const processStartTime = performance.now();

    if (uploadResponse.status === 429) {
      return {
        status: 'quota_exceeded',
        error_message: 'Rate limit exceeded. Try again later.',
        timings: { fetchTime: timings.fetchTime, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    if (uploadResponse.status !== 200 && uploadResponse.status !== 202) {
      return {
        status: 'fetch_error',
        error_message: `Upload failed: ${uploadResponse.status} - ${uploadResponse.statusText}`,
        timings: { fetchTime: timings.fetchTime, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    const result = uploadResponse.data;

    // Handle different response formats
    if (result.status === 'processing') {
      return {
        status: 'processing',
        job_id: result.job_id || result.id,
        progress: result.progress || 0,
        original_url: imageUrl,
        timings: { 
          fetchTime: timings.fetchTime, 
          processTime: performance.now() - processStartTime,
          totalTime: performance.now() - totalStartTime 
        }
      };
    }

    if (result.data && result.data.url) {
      return {
        status: 'success',
        original_url: imageUrl,
        upscaled_url: result.data.url,
        job_id: result.job_id || result.id,
        timings: { 
          fetchTime: timings.fetchTime, 
          processTime: performance.now() - processStartTime,
          totalTime: performance.now() - totalStartTime 
        }
      };
    }

    // Fallback: Extract from HTML response if API returns HTML
    if (typeof result === 'string' && result.includes('upscaled')) {
      const $result = cheerio.load(result);
      const upscaledUrl = $result('img[data-upscaled]').attr('src') || 
                         $result('.upscaled-image').attr('src') ||
                         $result('img').last().attr('src');

      if (upscaledUrl) {
        return {
          status: 'success',
          original_url: imageUrl,
          upscaled_url: upscaledUrl.startsWith('http') ? upscaledUrl : `https://picsart.com${upscaledUrl}`,
          timings: { 
            fetchTime: timings.fetchTime, 
            processTime: performance.now() - processStartTime,
            totalTime: performance.now() - totalStartTime 
          }
        };
      }
    }

    timings.processTime = performance.now() - processStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    return {
      status: 'not_found',
      error_message: 'Could not extract upscaled image URL from response',
      timings
    };

  } catch (error: any) {
    console.error("[PicsArt Upscaler Error]", error.message);
    
    timings.totalTime = performance.now() - totalStartTime;
    
    if (error.code === 'ECONNABORTED') {
      return {
        status: 'fetch_error',
        error_message: 'Request timeout - server took too long to respond',
        timings
      };
    }

    if (error.response?.status === 429) {
      return {
        status: 'quota_exceeded',
        error_message: 'Rate limit exceeded. Consider using proxies or waiting.',
        timings
      };
    }

    if (error.response?.status === 403) {
      return {
        status: 'access_denied',
        error_message: 'Access denied. IP might be blocked or detection triggered.',
        timings
      };
    }

    return {
      status: 'fetch_error',
      error_message: error.message || 'Unknown error occurred',
      timings
    };
  }
}

// Check job status for async processing
export async function checkUpscaleStatus(jobId: string): Promise<UpscaleResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  try {
    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const sessionCookies = generateSessionCookies();
    
    const headers = {
      ...HEADERS,
      "User-Agent": randomUserAgent,
      "Cookie": sessionCookies
    };

    const fetchStartTime = performance.now();
    
    const response = await axios.get(
      `https://api.picsart.com/tools/1.0/upscale/status/${jobId}`,
      { headers, timeout: 10000 }
    );

    timings.fetchTime = performance.now() - fetchStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    const result = response.data;

    if (result.status === 'completed' && result.data?.url) {
      return {
        status: 'success',
        job_id: jobId,
        upscaled_url: result.data.url,
        timings
      };
    }

    if (result.status === 'processing') {
      return {
        status: 'processing',
        job_id: jobId,
        progress: result.progress || 0,
        timings
      };
    }

    return {
      status: 'fetch_error',
      error_message: result.error || 'Job status unknown',
      timings
    };

  } catch (error: any) {
    return {
      status: 'fetch_error',
      error_message: error.message,
      timings: { fetchTime: 0, processTime: 0, totalTime: performance.now() - totalStartTime }
    };
  }
}

// Main handler function
export default async function handler(imageUrl: string, scale?: number) {
  return await scrapePicsArtUpscale(imageUrl, scale);
}
