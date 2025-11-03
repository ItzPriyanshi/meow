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
  service_used?: string;
  timings: {
    fetchTime: number;
    processTime: number;
    totalTime: number;
  };
};

// Updated headers for modern browsers
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "DNT": "1",
  "Connection": "keep-alive",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "cross-site",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache"
};

// Rotating user agents
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"
];

// Rate limiting
class RateLimiter {
  private requests: number[] = [];
  private readonly maxRequests = 3;
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

// Upscale.media implementation (Free service)
async function tryUpscaleMedia(imageUrl: string, scale: number): Promise<UpscaleResult> {
  console.log('Trying Upscale.media...');
  
  const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const headers = {
    ...HEADERS,
    "User-Agent": randomUserAgent,
    "Referer": "https://www.upscale.media/",
    "Origin": "https://www.upscale.media"
  };

  try {
    // First, fetch the image
    const imageResponse = await axios.get(imageUrl, {
      headers: { 'User-Agent': randomUserAgent },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    if (imageResponse.status !== 200) {
      throw new Error('Failed to fetch source image');
    }

    // Create form data
    const formData = new FormData();
    const imageBuffer = Buffer.from(imageResponse.data);
    const imageBlob = new Blob([imageBuffer], { 
      type: imageResponse.headers['content-type'] || 'image/jpeg' 
    });
    
    formData.append('image', imageBlob, 'image.jpg');
    formData.append('scale', Math.min(scale, 4).toString()); // Max 4x for free tier
    
    // Submit to upscale.media
    const uploadResponse = await axios.post('https://www.upscale.media/api/upscale', formData, {
      headers: {
        ...headers,
        'Content-Type': 'multipart/form-data'
      },
      timeout: 60000
    });

    if (uploadResponse.data && uploadResponse.data.output_url) {
      return {
        status: 'success',
        original_url: imageUrl,
        upscaled_url: uploadResponse.data.output_url,
        service_used: 'Upscale.media',
        timings: { fetchTime: 0, processTime: 0, totalTime: 0 }
      };
    }

    throw new Error('No output URL received');
    
  } catch (error: any) {
    console.log('Upscale.media failed:', error.message);
    throw error;
  }
}

// Waifu2x implementation (Free service)
async function tryWaifu2x(imageUrl: string, scale: number): Promise<UpscaleResult> {
  console.log('Trying Waifu2x...');
  
  const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const headers = {
    ...HEADERS,
    "User-Agent": randomUserAgent,
    "Referer": "https://waifu2x.net/",
    "Origin": "https://waifu2x.net"
  };

  try {
    // Fetch the source image
    const imageResponse = await axios.get(imageUrl, {
      headers: { 'User-Agent': randomUserAgent },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    if (imageResponse.status !== 200) {
      throw new Error('Failed to fetch source image');
    }

    // Create form data for waifu2x
    const formData = new FormData();
    const imageBuffer = Buffer.from(imageResponse.data);
    const imageBlob = new Blob([imageBuffer], { 
      type: imageResponse.headers['content-type'] || 'image/png' 
    });
    
    formData.append('file', imageBlob, 'image.png');
    formData.append('scale', Math.min(scale, 2).toString()); // Waifu2x typically supports 2x max
    formData.append('noise', '1'); // Noise reduction level
    formData.append('style', 'art'); // Art style works for most images
    
    // Submit to waifu2x
    const uploadResponse = await axios.post('https://api.waifu2x.net/upscale', formData, {
      headers: {
        ...headers,
        'Content-Type': 'multipart/form-data'
      },
      timeout: 120000 // Waifu2x can be slow
    });

    if (uploadResponse.data && uploadResponse.data.url) {
      return {
        status: 'success',
        original_url: imageUrl,
        upscaled_url: uploadResponse.data.url,
        service_used: 'Waifu2x',
        timings: { fetchTime: 0, processTime: 0, totalTime: 0 }
      };
    }

    throw new Error('No output URL received from Waifu2x');
    
  } catch (error: any) {
    console.log('Waifu2x failed:', error.message);
    throw error;
  }
}

// Pixelcut implementation (Free service)
async function tryPixelcut(imageUrl: string, scale: number): Promise<UpscaleResult> {
  console.log('Trying Pixelcut...');
  
  const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const headers = {
    ...HEADERS,
    "User-Agent": randomUserAgent,
    "Referer": "https://www.pixelcut.ai/image-upscaler",
    "Origin": "https://www.pixelcut.ai"
  };

  try {
    // Fetch the source image
    const imageResponse = await axios.get(imageUrl, {
      headers: { 'User-Agent': randomUserAgent },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    if (imageResponse.status !== 200) {
      throw new Error('Failed to fetch source image');
    }

    // Create form data
    const formData = new FormData();
    const imageBuffer = Buffer.from(imageResponse.data);
    const imageBlob = new Blob([imageBuffer], { 
      type: imageResponse.headers['content-type'] || 'image/jpeg' 
    });
    
    formData.append('image', imageBlob, 'image.jpg');
    formData.append('scale_factor', Math.min(scale, 4).toString());
    
    // Submit to Pixelcut
    const uploadResponse = await axios.post('https://api.pixelcut.ai/upscale', formData, {
      headers: {
        ...headers,
        'Content-Type': 'multipart/form-data'
      },
      timeout: 60000
    });

    if (uploadResponse.data && uploadResponse.data.result_url) {
      return {
        status: 'success',
        original_url: imageUrl,
        upscaled_url: uploadResponse.data.result_url,
        service_used: 'Pixelcut',
        timings: { fetchTime: 0, processTime: 0, totalTime: 0 }
      };
    }

    throw new Error('No result URL received');
    
  } catch (error: any) {
    console.log('Pixelcut failed:', error.message);
    throw error;
  }
}

// Cloudinary implementation (Free tier)
async function tryCloudinary(imageUrl: string, scale: number): Promise<UpscaleResult> {
  console.log('Trying Cloudinary...');
  
  try {
    // Cloudinary auto-upscale via URL transformation
    const cloudinaryUrl = `https://res.cloudinary.com/demo/image/fetch/w_auto:${scale * 100},c_scale,q_auto,f_auto/${encodeURIComponent(imageUrl)}`;
    
    // Test if the URL works
    const testResponse = await axios.head(cloudinaryUrl, {
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENTS[0] }
    });

    if (testResponse.status === 200) {
      return {
        status: 'success',
        original_url: imageUrl,
        upscaled_url: cloudinaryUrl,
        service_used: 'Cloudinary',
        timings: { fetchTime: 0, processTime: 0, totalTime: 0 }
      };
    }

    throw new Error('Cloudinary transformation failed');
    
  } catch (error: any) {
    console.log('Cloudinary failed:', error.message);
    throw error;
  }
}

// Main scraper function with multiple fallbacks
export async function scrapePicsArtUpscale(imageUrl: string, scale: number = 2): Promise<UpscaleResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  try {
    await rateLimiter.checkLimit();

    // Validate image URL
    try {
      new URL(imageUrl);
    } catch {
      return {
        status: 'fetch_error',
        error_message: 'Invalid image URL format',
        timings: { fetchTime: 0, processTime: 0, totalTime: performance.now() - totalStartTime }
      };
    }

    // Validate scale (1-8x max)
    const scaleValue = Math.min(Math.max(scale, 1), 8);
    
    const fetchStartTime = performance.now();

    // Try services in order of reliability
    const services = [
      () => tryUpscaleMedia(imageUrl, scaleValue),
      () => tryCloudinary(imageUrl, scaleValue),
      () => tryWaifu2x(imageUrl, scaleValue),
      () => tryPixelcut(imageUrl, scaleValue)
    ];

    let lastError: Error | null = null;

    for (const service of services) {
      try {
        const result = await service();
        timings.fetchTime = performance.now() - fetchStartTime;
        timings.processTime = 0;
        timings.totalTime = performance.now() - totalStartTime;
        
        return {
          ...result,
          timings
        };
      } catch (error: any) {
        lastError = error;
        console.log(`Service failed, trying next...`);
        
        // Add delay between service attempts
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
    }

    // All services failed
    timings.fetchTime = performance.now() - fetchStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    return {
      status: 'fetch_error',
      error_message: `All upscaling services failed. Last error: ${lastError?.message || 'Unknown error'}`,
      timings
    };

  } catch (error: any) {
    console.error("[Multi-Service Upscaler Error]", error.message);
    
    timings.totalTime = performance.now() - totalStartTime;
    
    if (error.code === 'ECONNABORTED') {
      return {
        status: 'fetch_error',
        error_message: 'Request timeout - server took too long to respond',
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
