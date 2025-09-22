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

// Updated headers for PicsArt web interface
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Referer": "https://picsart.com/image-upscale/",
  "Origin": "https://picsart.com",
  "DNT": "1",
  "Connection": "keep-alive",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
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

// Generate realistic session data
function generateDeviceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function generateSessionCookies(): string {
  const deviceId = generateDeviceId();
  const sessionId = generateSessionId();
  const timestamp = Date.now();
  
  return [
    `device_id=${deviceId}`,
    `session_id=${sessionId}`,
    `timestamp=${timestamp}`,
    `user_consent=accepted`,
    `csrf_token=${crypto.randomBytes(32).toString('hex')}`,
    `visit_count=${Math.floor(Math.random() * 50) + 1}`,
    `last_activity=${Date.now()}`
  ].join('; ');
}

class RateLimiter {
  private requests: number[] = [];
  private readonly maxRequests = 50;
  private readonly timeWindow = 60000;

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

// Main scraper function using PicsArt's web interface
export async function scrapePicsArtUpscale(imageUrl: string, scale: number = 2): Promise<UpscaleResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  try {
    await rateLimiter.checkLimit();

    // Rotate user agent and generate fresh session
    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const sessionCookies = generateSessionCookies();
    
    const headers = {
      ...HEADERS,
      "User-Agent": randomUserAgent,
      "Cookie": sessionCookies,
      "X-Device-Id": generateDeviceId(),
      "X-Session-Id": generateSessionId(),
      "X-Request-Id": crypto.randomUUID()
    };

    const fetchStartTime = performance.now();

    // Step 1: Get the upscaler page to extract necessary data
    console.log('Loading PicsArt upscaler page...');
    const initialResponse = await axios.get('https://picsart.com/image-upscale/', {
      headers,
      timeout: 15000,
      maxRedirects: 3,
      validateStatus: (status: number) => status < 500
    });
    
    if (initialResponse.status !== 200) {
      return {
        status: 'access_denied',
        error_message: `Failed to load upscaler page: ${initialResponse.status}`,
        timings: { fetchTime: 0, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    const $ = cheerio.load(initialResponse.data);
    
    // Extract CSRF token and other form data
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || 
                     $('input[name="_token"]').attr('value') ||
                     $('meta[name="_token"]').attr('content') ||
                     crypto.randomBytes(32).toString('hex');

    // Look for upload endpoint in script tags
    let uploadEndpoint = 'https://picsart.com/api/upscale';
    const scripts = $('script').toArray();
    for (const script of scripts) {
      const content = $(script).html() || '';
      if (content.includes('upscale') && content.includes('api')) {
        const apiMatch = content.match(/["']([^"']*api[^"']*upscale[^"']*)["']/i);
        if (apiMatch) {
          uploadEndpoint = apiMatch[1].startsWith('/') ? `https://picsart.com${apiMatch[1]}` : apiMatch[1];
          break;
        }
      }
    }

    console.log(`Using endpoint: ${uploadEndpoint}`);

    // Step 2: Create form data for image upload
    const formData = new FormData();
    
    // Try to fetch the image first to get its data
    console.log('Fetching source image...');
    const imageResponse = await axios.get(imageUrl, {
      headers: { 'User-Agent': randomUserAgent },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    if (imageResponse.status !== 200) {
      return {
        status: 'fetch_error',
        error_message: 'Failed to fetch source image',
        timings: { fetchTime: performance.now() - fetchStartTime, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    // Create blob from image data
    const imageBuffer = Buffer.from(imageResponse.data);
    const imageBlob = new Blob([imageBuffer], { type: imageResponse.headers['content-type'] || 'image/jpeg' });
    
    formData.append('image', imageBlob, 'image.jpg');
    formData.append('scale', scale.toString());
    formData.append('_token', csrfToken);
    formData.append('output_format', 'png');
    formData.append('enhance_quality', 'true');

    // Step 3: Submit the upscale request
    console.log('Submitting upscale request...');
    const uploadHeaders = {
      ...headers,
      'Content-Type': 'multipart/form-data',
      'X-CSRF-TOKEN': csrfToken,
      'X-Requested-With': 'XMLHttpRequest'
    };

    const uploadResponse = await axios.post(uploadEndpoint, formData, {
      headers: uploadHeaders,
      timeout: 60000,
      maxRedirects: 3,
      validateStatus: (status: number) => status < 500
    });

    timings.fetchTime = performance.now() - fetchStartTime;
    const processStartTime = performance.now();

    console.log(`Upload response status: ${uploadResponse.status}`);

    if (uploadResponse.status === 429) {
      return {
        status: 'quota_exceeded',
        error_message: 'Rate limit exceeded. Try again later.',
        timings: { fetchTime: timings.fetchTime, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    if (uploadResponse.status === 402) {
      return {
        status: 'quota_exceeded',
        error_message: 'Daily limit reached. Upgrade to continue.',
        timings: { fetchTime: timings.fetchTime, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    if (uploadResponse.status !== 200 && uploadResponse.status !== 201 && uploadResponse.status !== 202) {
      return {
        status: 'fetch_error',
        error_message: `Upload failed: ${uploadResponse.status} - ${uploadResponse.statusText}`,
        timings: { fetchTime: timings.fetchTime, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    const result = uploadResponse.data;
    console.log('Upload result:', JSON.stringify(result, null, 2));

    // Handle different response formats
    if (typeof result === 'object') {
      // Direct success response
      if (result.url || result.data?.url || result.image_url) {
        const upscaledUrl = result.url || result.data?.url || result.image_url;
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

      // Processing response
      if (result.status === 'processing' || result.job_id || result.id) {
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
    }

    // Fallback: Try to parse HTML response
    if (typeof result === 'string') {
      const $result = cheerio.load(result);
      const upscaledUrl = $result('img[data-upscaled]').attr('src') || 
                         $result('.upscaled-image').attr('src') ||
                         $result('img[src*="upscaled"]').attr('src') ||
                         $result('.result-image img').attr('src');

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
        error_message: 'Rate limit exceeded. Try again in a few minutes.',
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

    if (error.response?.status === 402) {
      return {
        status: 'quota_exceeded',
        error_message: 'Daily quota exceeded. Service may require subscription.',
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

// Main handler function
export default async function handler(imageUrl: string, scale?: number) {
  return await scrapePicsArtUpscale(imageUrl, scale || 2);
}
