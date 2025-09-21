import axios from 'axios';
import * as cheerio from 'cheerio/slim';
import { performance } from 'perf_hooks';

type CleanedMedia = {
  type: 'video' | 'photo';
  url: string;
};

export type ExtractionResult = {
  status: 'success' | 'not_found' | 'fetch_error' | 'access_denied';
  author?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  timings: { fetchTime: number; processTime: number; totalTime: number };
};

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

export async function scrapePinterest(url: string): Promise<ExtractionResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

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
      validateStatus: (status) => status < 500, // Don't throw on 404, 403, etc.
      decompress: true,
    });

    timings.fetchTime = performance.now() - fetchStartTime;

    // Check for access denied errors in response
    if (response.data.includes('<Code>AccessDenied</Code>') || 
        response.data.includes('Access Denied') ||
        response.status === 403) {
      return { status: 'access_denied', timings };
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
        const scriptContent = $(el).html()?.replace(/\/\*[\s\S]*?\*\//g, ''); // Remove comments
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
        // Try parsing as array
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
        if (scriptContent && scriptContent.includes('__PINTEREST__') || 
            scriptContent.includes('initialData')) {
          try {
            // Extract JSON from script content
            const jsonMatch = scriptContent.match(/(\{.*\})/s);
            if (jsonMatch) {
              const data = JSON.parse(jsonMatch[1]);
              // Navigate through Pinterest's complex data structure
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
      // Check for video tags
      const videoTag = $('video[src], video source[src]');
      if (videoTag.length) {
        videoUrl = videoTag.attr('src') || videoTag.first().attr('src');
      }
      
      // Check for data attributes that might contain video URLs
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

    if (media.length === 0) return { status: 'not_found', timings };

    return {
      status: 'success',
      author: author?.trim(),
      title: title?.trim(),
      description: description?.trim(),
      thumbnail: cleanUrl(thumbnail),
      media,
      timings,
    };
  } catch (error: any) {
    console.error("[Pinterest Scraper Error]", error.message);
    
    if (error.response?.status === 403 || error.response?.status === 401) {
      return { status: 'access_denied', timings };
    }
    
    timings.totalTime = performance.now() - totalStartTime;
    return { status: 'fetch_error', timings };
  }
}

export default async function handler(url: string) {
  return await scrapePinterest(url);
}