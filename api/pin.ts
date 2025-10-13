import axios from 'axios';
import * as cheerio from 'cheerio/slim';
import { performance } from 'perf_hooks';

type CleanedMedia = {
  type: 'video' | 'photo';
  url: string;
};

export type ExtractionResult = {
  status: 'success' | 'not_found' | 'fetch_error' | 'access_denied' | 'rate_limited';
  author?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  timings: { fetchTime: number; processTime: number; totalTime: number };
  cached?: boolean;
  error?: string;
};

export type SearchResult = {
  status: 'success' | 'error' | 'rate_limited';
  query?: string;
  results?: Array<{
    id: string;
    title: string;
    image: string;
    url: string;
    author?: string;
    description?: string;
  }>;
  count?: number;
  timings: { fetchTime: number; processTime: number; totalTime: number };
  cached?: boolean;
  error?: string;
};

// Cache configuration
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 1000, ttlMs: number = 300000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttlMs;
  }

  set(key: string, value: T): void {
    // Remove oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      data: value,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.ttl
    });
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (LRU behavior)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    return entry.data;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// Rate limiter configuration
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

class RateLimiter {
  private requests: Map<string, RateLimitEntry>;
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = 30, windowMs: number = 60000) {
    this.requests = new Map();
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    
    // Cleanup old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  check(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
    const now = Date.now();
    const entry = this.requests.get(identifier);

    if (!entry || now > entry.resetTime) {
      // New window
      this.requests.set(identifier, {
        count: 1,
        resetTime: now + this.windowMs
      });
      
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: now + this.windowMs
      };
    }

    if (entry.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime
      };
    }

    entry.count++;
    
    return {
      allowed: true,
      remaining: this.maxRequests - entry.count,
      resetTime: entry.resetTime
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.requests.entries()) {
      if (now > entry.resetTime) {
        this.requests.delete(key);
      }
    }
  }

  reset(identifier: string): void {
    this.requests.delete(identifier);
  }
}

// Initialize caches and rate limiters
const pinCache = new LRUCache<ExtractionResult>(500, 5 * 60 * 1000); // 500 entries, 5 min TTL
const searchCache = new LRUCache<SearchResult>(200, 3 * 60 * 1000); // 200 entries, 3 min TTL

const pinRateLimiter = new RateLimiter(20, 60000); // 20 requests per minute
const searchRateLimiter = new RateLimiter(10, 60000); // 10 requests per minute

// Updated headers with better browser fingerprinting
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.pinterest.com/",
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

// Rotating user agents to avoid detection
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
];

const COOKIES = [
  `_pinterest_sess=TWc9PSZrVk5UWllUUHljUXN2N09Cakt5YVpaVEhGL2I2ZW5FZ3Nna3VVOWRkUzhEZU1FNFNSVmlweUdKSVJJdWNrek5vaFpqR1Y0VVpSWEJaMHlnQld1TWFPSXVQdHJJdWxsMEF5YUpBbW81RktLUDByeWMzMWRyRGFmSHQySENPdEJnTTdlZFFZazFRR0pDM3gvQ2tqYVBRdVBVNDJnekp4R1hhNy9la0ZxWkc2ZjV6ZjRvM3NWRTJreVVHWDVyaG8xbXBBV1hmaERLeDRCS2ZONC9qY3Bpa2lmMmxXR1hFVlJJMFF3K1pPejc1eDN2RXNiMzMxWjJkNlNiRjFUWmdZcGc5bEFiUDBnczlheGJ4SU1tOG5PTi9FZHIveDlYTjhnNjVBWnU3ekdzRHJPR3lQOW5QTTBaai9jSzZKVDdROUZJNnNES01nd0lBUDlPdXhXNkRYMWtmTXJkVnVLQ2s4YUpIOG00Y3cwMWVtS3BXL011dFZYdi9UVmhhOHUya1R4eFB5Q2FlemUzUmJUcFpvcGoxNCtpNFdaNDIrb3NvUlV5eCtXTHdlZnhrdDF5TnZUK1owU1I1N0djbVZDY3Z0eGNIbDdGd2Z1cXkrNS9McHhpMlJuSndDT3kwYTU3UVdiKytUdlRIZEN5ZXFDTXVtOEVscmZXUDJoaGwwT1VTNmlnOENWSG1KTXNTVTVndmZlZ0dyQkxZNmYrQUZzTFBkd2ZEUjlvQzN5dUFiTVpNd3RvWSt5WWNnTlFEN2FpTDRQMElnMG1KVktsZnN0cG9Bdk14N0NHQmJ5RlFzRmJpcjl5WVI5UUtBL3hrdEZlZm1PZDRwUXdaRTJGR1RMUS83b0IxUG5xMzVDL0I2Rm0rTWt1ZzdSTHpZRTBCYUNOMnlyb1dEUUJPb25IRWRVVmFlU3lhVGVJRDNJRDVxdGhJc2tzek54dGVJa0x0TUN2RWxSSVYxUkNydzUwZkhuVGpoaUFzU09DTHlncDZQcXpSeEpxTDQ5Y01vT1crOW13NC84c2gzQjVVS011WjNHaE40Q3FLdUlyRnJpQ1VyQ28yK1hQa1pPblI4ZDJSdGZFQ2NobDV3eXF5VVBXRU51NnhZcTUrSDBBdkpXeWhwQWpyUlFqT2hsU0t1ODVTZllkMFlkbmgxRFM1TWNyRlZSeXE2NktLa1RteEZXa1YzL0ZKVE9XM0hId2VCd1dPcXNFbXRMKy9Ba29GSnl1bG1lUUtLb0RHZklVTE9GNVplZ2pMZXZzSXRZMStSQ3VyMithdy9iV3V1YllrT005VU0wVHJXdW5Zd0RjMDBmTmlIVDFEdjhoYmwrWk9ORUhFNjAyelJZbDA3QnpNa2hkY1hZV1dpdkFiM21YVW4wUkJiblJsbzl2VzVtclQxTnFoYXhvWmk5Q1RRb2tiVnhVSU9rR0hSOUlUeUlLZXVoeXR4aTRLbFpMS0FCMHJUaWgrVjNaMmExUTJqRXYyWFc1QXN5TUYzN0UwNEdaNGVmKzE4Y2RscTRHMndmcGdZSW9PeGdLUS83aktoclNHVDgzUVowdnhPNTRHQm1WL2VuVnF3S3BkRVl4UExYZTM1d0txbjh0VDcycUl0ZmJpcHppWmxuL0FNR1RpUi95c1BnSDRIdkNJNGVCaXYwZjRzWUgxb0hVR2ZZemlFWWJtazREam15cGVnVzBmRytHNy90QnBMTm00dVBaUWhWQVZBWDltZmthZ0djSVQxNzFEQzI4eGNxbjBadHN1TkExQldzYVh0eVQwQ0p5WjQ1WElmc0U0VzU0aW9vQUsmZ29UOWRoV1hDaG5uZGVMVDRmaG5SOGc5eWhRPQ==`,
  `_auth=1`,
  `csrftoken=43d00acdb1fe82281803190d1c2035e5`,
  `sessionFunnelEventLogged=1`,
  `_routing_id="d31946a7-87b3-4bc0-99c8-de8805de3bad"`,
  `_b="AYwMzNrypdJLdYDIM5IYBguwLCBNrRtlwi+GPtw+Lk6/GeGKmyzfZIy+ls1GyUqwqfc="`
].join("; ");

export async function scrapePinterest(url: string, clientId: string = 'default'): Promise<ExtractionResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  // Check cache first
  const cacheKey = `pin:${url}`;
  const cachedResult = pinCache.get(cacheKey);
  if (cachedResult) {
    console.log(`[Pinterest] Cache HIT for ${url}`);
    return { ...cachedResult, cached: true };
  }

  // Check rate limit
  const rateLimitResult = pinRateLimiter.check(clientId);
  if (!rateLimitResult.allowed) {
    const waitTime = Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000);
    return {
      status: 'rate_limited',
      timings,
      error: `Rate limit exceeded. Try again in ${waitTime} seconds.`
    };
  }

  try {
    // Rotate user agent
    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const headers = {
      ...HEADERS,
      "User-Agent": randomUserAgent,
      "Cookie": COOKIES
    };

    const fetchStartTime = performance.now();

    // Use axios with better configuration to mimic browser behavior
    const response = await axios.get(url, {
      headers,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
      decompress: true,
    });

    timings.fetchTime = performance.now() - fetchStartTime;

    // Check for access denied errors in response
    if (response.data.includes('<Code>AccessDenied</Code>') || 
        response.data.includes('Access Denied') ||
        response.status === 403) {
      const result = { status: 'access_denied' as const, timings };
      pinCache.set(cacheKey, result);
      return result;
    }

    const html = response.data;
    const processStartTime = performance.now();
    const $ = cheerio.load(html);

    let title: string | undefined;
    let author: string | undefined;
    let description: string | undefined;
    let thumbnail: string | undefined;
    let videoUrl: string | null = null;
    let imageUrl: string | undefined;

    // Method 1: Check for JSON-LD data
    let ldJsonData: any = null;
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const scriptContent = $(el).html()?.replace(/\/\*[\s\S]*?\*\//g, '');
        if (scriptContent) {
          const jsonData = JSON.parse(scriptContent);
          if (jsonData["@type"] && (jsonData["@type"].includes("VideoObject") || 
                                   jsonData["@type"].includes("ImageObject") || 
                                   jsonData["@type"].includes("Pin"))) {
            ldJsonData = jsonData;
            return false;
          }
        }
      } catch (e) {
        try {
          const jsonArray = JSON.parse($(el).html() || '[]');
          if (Array.isArray(jsonArray)) {
            const pinData = jsonArray.find(item => 
              item["@type"] && (item["@type"].includes("VideoObject") || 
                              item["@type"].includes("ImageObject") || 
                              item["@type"].includes("Pin"))
            );
            if (pinData) {
              ldJsonData = pinData;
              return false;
            }
          }
        } catch (e2) {}
      }
    });

    if (ldJsonData) {
      title = ldJsonData.name || ldJsonData.headline || ldJsonData.title;
      author = ldJsonData.author?.name || ldJsonData.creator?.name || ldJsonData.publisher?.name;
      description = ldJsonData.description;
      thumbnail = ldJsonData.thumbnailUrl || ldJsonData.image || ldJsonData.thumbnail;
      imageUrl = ldJsonData.contentUrl || ldJsonData.image || ldJsonData.url;
      videoUrl = ldJsonData.contentUrl || ldJsonData.embedUrl || null;
    }

    // Method 2: Check for Pinterest-specific JSON data
    if (!ldJsonData) {
      $('script').each((_i, el) => {
        const scriptContent = $(el).html();
        if (scriptContent && (scriptContent.includes('__PINTEREST__') || 
            scriptContent.includes('initialData'))) {
          try {
            const jsonMatch = scriptContent.match(/(\{.*\})/s);
            if (jsonMatch) {
              const data = JSON.parse(jsonMatch[1]);
              const pinData = data?.props?.initialReduxState?.pins || 
                            data?.resourceDataCache || 
                            data?.initialData;

              if (pinData) {
                const pinKey = Object.keys(pinData).find(key => key.includes('PinResource'));
                if (pinKey && pinData[pinKey]) {
                  const pin = pinData[pinKey].data;
                  title = title || pin.title || pin.description;
                  author = author || pin.pinner?.username || pin.owner?.username;
                  thumbnail = thumbnail || pin.images?.orig?.url || pin.image?.url;
                  videoUrl = videoUrl || pin.videos?.video_list?.V_720P?.url || 
                            pin.videos?.video_list?.V_360P?.url;
                  imageUrl = imageUrl || pin.images?.orig?.url || pin.image?.url;
                }
              }
            }
          } catch (e) {}
        }
      });
    }

    // Method 3: Fallback to meta tags
    if (!title) title = $('meta[property="og:title"]').attr("content") || 
                       $('meta[name="title"]').attr("content");

    if (!description) description = $('meta[property="og:description"]').attr("content") || 
                                  $('meta[name="description"]').attr("content");

    if (!thumbnail) thumbnail = $('meta[property="og:image"]').attr("content") || 
                              $('meta[name="image"]').attr("content");

    if (!author) {
      const authorMeta = $('meta[property="og:see_also"]').attr("content") || 
                        $('meta[name="pinterest:user"]').attr("content");
      if (authorMeta) author = authorMeta.split('/').filter(Boolean).pop();
    }

    // Method 4: Direct video extraction
    if (!videoUrl) {
      const videoTag = $('video[src], video source[src]');
      if (videoTag.length) {
        videoUrl = videoTag.attr('src') || videoTag.first().attr('src');
      }

      $('[data-video-url], [data-video-src]').each((_i, el) => {
        const videoSrc = $(el).attr('data-video-url') || $(el).attr('data-video-src');
        if (videoSrc && !videoUrl) videoUrl = videoSrc;
      });
    }

    // Handle m3u8 conversion
    if (videoUrl && videoUrl.includes(".m3u8")) {
      videoUrl = videoUrl.replace("/hls/", "/expMp4/")
                        .replace(".m3u8", "_t1.mp4")
                        .replace("https://v1.pinimg.com", "https://v.pinimg.com");
    }

    // Clean up URLs
    const cleanUrl = (url: string | undefined) => {
      if (!url) return undefined;
      return url.replace(/\\\//g, '/')
               .replace(/\/$/, '')
               .trim();
    };

    const media: CleanedMedia[] = [];
    if (videoUrl) {
      media.push({ type: 'video', url: cleanUrl(videoUrl)! });
    } else if (imageUrl) {
      media.push({ type: 'photo', url: cleanUrl(imageUrl)! });
    }

    timings.processTime = performance.now() - processStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    if (media.length === 0) {
      const result = { status: 'not_found' as const, timings };
      pinCache.set(cacheKey, result);
      return result;
    }

    const result: ExtractionResult = {
      status: 'success',
      author: author?.trim(),
      title: title?.trim(),
      description: description?.trim(),
      thumbnail: cleanUrl(thumbnail),
      media,
      timings,
      cached: false
    };

    // Cache successful result
    pinCache.set(cacheKey, result);
    
    return result;
  } catch (error: any) {
    console.error("[Pinterest Scraper Error]", error.message);

    if (error.response?.status === 403 || error.response?.status === 401) {
      const result = { status: 'access_denied' as const, timings };
      return result;
    }

    timings.totalTime = performance.now() - totalStartTime;
    return { status: 'fetch_error', timings, error: error.message };
  }
}

export async function searchPinterest(query: string, clientId: string = 'default', limit: number = 20): Promise<SearchResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  // Check cache first
  const cacheKey = `search:${query}:${limit}`;
  const cachedResult = searchCache.get(cacheKey);
  if (cachedResult) {
    console.log(`[Pinterest Search] Cache HIT for query: ${query}`);
    return { ...cachedResult, cached: true };
  }

  // Check rate limit
  const rateLimitResult = searchRateLimiter.check(clientId);
  if (!rateLimitResult.allowed) {
    const waitTime = Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000);
    return {
      status: 'rate_limited',
      timings,
      error: `Rate limit exceeded. Try again in ${waitTime} seconds.`
    };
  }

  try {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodedQuery}`;

    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const headers = {
      ...HEADERS,
      "User-Agent": randomUserAgent,
      "Cookie": COOKIES
    };

    const fetchStartTime = performance.now();

    const response = await axios.get(searchUrl, {
      headers,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
      decompress: true,
    });

    timings.fetchTime = performance.now() - fetchStartTime;

    if (response.status === 403 || response.status === 401) {
      return { 
        status: 'error', 
        error: 'Access denied by Pinterest',
        timings 
      };
    }

    const html = response.data;
    const processStartTime = performance.now();
    const $ = cheerio.load(html);

    const results: Array<{
      id: string;
      title: string;
      image: string;
      url: string;
      author?: string;
      description?: string;
    }> = [];

    // Method 1: Try to extract from JSON-LD
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const scriptContent = $(el).html();
        if (scriptContent) {
          const jsonData = JSON.parse(scriptContent);
          if (jsonData["@type"] === "ItemList" && jsonData.itemListElement) {
            jsonData.itemListElement.forEach((item: any) => {
              if (item.item && results.length < limit) {
                results.push({
                  id: item.item.url?.split('/pin/')[1]?.split('/')[0] || `pin-${results.length}`,
                  title: item.item.name || item.item.headline || 'Untitled Pin',
                  image: item.item.image || item.item.thumbnailUrl || '',
                  url: item.item.url || '',
                  author: item.item.author?.name,
                  description: item.item.description
                });
              }
            });
          }
        }
      } catch (e) {}
    });

    // Method 2: Try to extract from Pinterest's embedded JSON data
    if (results.length === 0) {
      $('script').each((_i, el) => {
        const scriptContent = $(el).html();
        if (scriptContent && (scriptContent.includes('__PINTEREST__') || scriptContent.includes('initialReduxState'))) {
          try {
            const jsonMatch = scriptContent.match(/(\{.*\})/s);
            if (jsonMatch) {
              const data = JSON.parse(jsonMatch[1]);
              
              const searchData = data?.props?.initialReduxState?.search?.searchPage || 
                               data?.props?.initialReduxState?.pins ||
                               data?.resourceDataCache;

              if (searchData) {
                Object.keys(searchData).forEach(key => {
                  if (results.length >= limit) return;
                  
                  const item = searchData[key];
                  if (item && item.data) {
                    const pin = item.data;
                    if (pin.id || pin.images) {
                      results.push({
                        id: pin.id || `pin-${results.length}`,
                        title: pin.title || pin.description || pin.grid_title || 'Untitled Pin',
                        image: pin.images?.orig?.url || pin.images?.['736x']?.url || pin.image_medium_url || '',
                        url: `https://www.pinterest.com/pin/${pin.id}`,
                        author: pin.pinner?.username || pin.owner?.username,
                        description: pin.description || pin.seo_description
                      });
                    }
                  }
                });
              }
            }
          } catch (e) {
            console.error('[Pinterest Search] JSON parsing error:', e);
          }
        }
      });
    }

    // Method 3: Fallback to meta tags and images
    if (results.length === 0) {
      $('img[src*="pinimg.com"]').each((i, el) => {
        if (results.length >= limit) return;
        
        const imgSrc = $(el).attr('src');
        const imgAlt = $(el).attr('alt') || 'Untitled Pin';
        const parent = $(el).closest('a');
        const pinUrl = parent.attr('href');
        
        if (imgSrc && (imgSrc.includes('236x') || imgSrc.includes('474x') || imgSrc.includes('736x'))) {
          const highQualityImg = imgSrc.replace('/236x/', '/originals/')
                                       .replace('/474x/', '/originals/')
                                       .replace('/736x/', '/originals/');
          
          const pinId = pinUrl?.split('/pin/')[1]?.split('/')[0] || `pin-${i}`;
          
          results.push({
            id: pinId,
            title: imgAlt,
            image: highQualityImg,
            url: pinUrl ? `https://www.pinterest.com${pinUrl}` : `https://www.pinterest.com/pin/${pinId}`,
            description: imgAlt
          });
        }
      });
    }

    timings.processTime = performance.now() - processStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    const result: SearchResult = {
      status: 'success',
      query,
      results: results.slice(0, limit),
      count: results.length,
      timings,
      cached: false
    };

    // Cache successful search result
    searchCache.set(cacheKey, result);

    return result;

  } catch (error: any) {
    console.error("[Pinterest Search Error]", error.message);
    timings.totalTime = performance.now() - totalStartTime;
    
    return {
      status: 'error',
      error: error.message,
      timings
    };
  }
}

// Export cache and rate limiter stats for monitoring
export function getCacheStats() {
  return {
    pinCache: {
      size: pinCache.size(),
      maxSize: 500
    },
    searchCache: {
      size: searchCache.size(),
      maxSize: 200
    }
  };
}

export function clearCaches() {
  pinCache.clear();
  searchCache.clear();
}

export default async function handler(url: string, clientId?: string) {
  return await scrapePinterest(url, clientId);
}
