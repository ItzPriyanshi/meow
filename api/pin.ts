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

// Session cookies (rotate these periodically)
const COOKIES = [
  `_pinterest_sess=TWc9PSZYUjY5NFF1NVBaVUFRblgrV3FQVmlkR053NGpoZHRNeU1tNG4zNjNXT2xYWjJtNlY0c1hKUjBMK3JMenUrYVpoUlI4REZqaVZtTWJNcnFRRC9abHpFVVR1cWw4dEs5NllvNDVUUTRhSVYwZkV2ajVRRmFSWUtOMnBtYTZYbkVybXFaYTB3SFhQODNxMHhxUk5LemJXRjd0bisxdDJBdkZVNWJpRkh5U2IyRmZXY3k5TnNta2xHQ0RYMTFoY3VkZUdrQWs5OGlYTDJXVS9zUlgyZll2TkNWRUFJTWFmeGkraldIT1JxU2RIOGwxOVlGQ2FnTzJ6VnIzNzFwd1IwZGp0Q3BBZzVLRlFWb0xSNFRBeDBVS1U5aUg2NkYvRmhXb01KdnBLSjhUc09WbDlLRlJrdjJ1OVNKSjFRb2I1dlBUVTk3K1ExYTFzNm1uZmtLQW5zaHZTY0puS3B6VXJyMEl6YVVqeVhsQ1NYK3ozOVhiU2NzUGZwVEtta0NoQXVoY2dtV3A0TGlIZHlDd2tmU2s3cVNxdEltbDhuUVdKVSsxTlhUa1NDbm5aWGcrZFdtVG9PNjQ1S0dYSHVxUG5pVGZrMU1BcFlhc3hlWitTWks3UjhXNUlselFpQVZySHREYkhmN2xJNzFtb3h2cmI4UjE4K0hPdXF0aitOalFpQVEvTVdTek83WTlXTDJKS2szM3BUcUdQT3o2dEdJN3Y4MUZiYTFKbHZKU3d3QldEaU0wdWJzYlNtMXBNZ0RkSXZiM3lNOElnOU9VRlp2WFdOVGxxY0NmanRpSDgyT05jTGRhYzdvQldSeHlmVkdIQmY0MnpoWUkrNlZoU2htcXR3NWgyWHJwK0hsTnNBU2JKYWxjNGZBcFZZT1k4RXJxT3ZNbGc3R240ZDcxOWEyVlBXczU1SGZpUk9WWDd2Nm85ajUydzFUTU9EMU5MV0FKcUd5UTRpUHllaGV6NmFPVjJsZlllYkRnYkNmNjFzaDRXNU1pRzJ5bXp5VlNpUXZ6cUt1UGFMZmQ0WU1yamYvbTU5SStZNEY4Z3B2b05DY09lSmU4R1BsZW1KczV2cDRFelVnWkhCUkI4SHY4Njl1aFV3QXNXVDZRMkxMMXVSc05DdmFrNlNUMXRCNmxzNms5SzJlY1lOWTVGUndpL0hQbnZSbnF2a2VtZGZTYklIWVRLUUhOcytjcTFzdFMxeW8xVWY5OTJ1RDU0dW84TDJ5RCtReHdRTWRyU3VQeENmcEowdjNWZlJkd0wxQkFBdVFTU2EzZlRUbS91dzdFOE5DNFVrSEtFNnZPdlhVdzJmRC92ZUpzckwyZGwzYVhTMmNFbUs2WEYyUzYyaG43N0YyT1FLYlVPZlF6TnczWUJ2SG03eVhUcVZQU3c1QlQ3cjc3V0dWVFNVUzN6SHVOVlBCZ1ZZaGdsRUJUMXRoM0lEWkZnWlJCbGxyZ1ZmSW0rM2ZIQ1FvKzFxQlJVdzNMZWppckUvcWxaZXc2ckdmakd0K2xyQkNJbzMwWEVwYmtVcjZTU0diVXhpK2NZRy9yQVp1R296a2duOXhCemtHbHFPRkhVSjRJVEcxUWE4MjM3Q2hjcjBTd3pCMFFJS3lLb2lvWlExSXFZQnVidUt0bFpNdzRGcGVlOXorcmRaY1ZqcktZNkpkTFNOMlQvR1N3SnRFaUZzMGQ1VFdhc0ovRzdKcXpPNi9JYXJNUjdTanRHc0haRjhmRUJSRlM0ekVlNk9aVjNZRk5YU0lzZ0Q4UGo5ZGNJc3I2aUs5VWdRcUpIQzBvdlNDSEomZlBUVk53SkQ2ZVB6M3FoZXhlUG5jRFZ2Yi8wPQ==`,
  `_auth=1`,
  `csrftoken=8cf180c9739e33542e8ab6da510d3184`,
  `sessionFunnelEventLogged=1`,
  `_routing_id="f2922fb9-a60a-4218-bdde-ea12cfbd5c81"`,
  `_b="AYyiPhmzQC5C6IlyLdV3xWR0lImjuhTti2Zvq0ECevFVLaw8O5GFeXc4SR8g3RuSUyg="`
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