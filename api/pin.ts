import axios from 'axios';
import * as cheerio from 'cheerio/slim';
import { performance } from 'perf_hooks';

type CleanedMedia = {
  type: 'video' | 'photo';
  url: string;
};

export type ExtractionResult = {
  status: 'success' | 'not_found' | 'fetch_error';
  author?: string;
  title?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  timings: { fetchTime: number; processTime: number; totalTime: number };
};

// Use modern UA + ref + cookies
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.pinterest.com/",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

export async function scrapePinterest(url: string): Promise<ExtractionResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  try {
    const fetchStartTime = performance.now();
    const response = await axios.get(url, {
      headers: HEADERS,
      // If you have a Pinterest session cookie, put it here
      // headers: { ...HEADERS, Cookie: '_pinterest_sess=TWc9PSZYUjY5NFF1NVBaVUFRblgrV3FQVmlkR053NGpoZHRNeU1tNG4zNjNXT2xYWjJtNlY0c1hKUjBMK3JMenUrYVpoUlI4REZqaVZtTWJNcnFRRC9abHpFVVR1cWw4dEs5NllvNDVUUTRhSVYwZkV2ajVRRmFSWUtOMnBtYTZYbkVybXFaYTB3SFhQODNxMHhxUk5LemJXRjd0bisxdDJBdkZVNWJpRkh5U2IyRmZXY3k5TnNta2xHQ0RYMTFoY3VkZUdrQWs5OGlYTDJXVS9zUlgyZll2TkNWRUFJTWFmeGkraldIT1JxU2RIOGwxOVlGQ2FnTzJ6VnIzNzFwd1IwZGp0Q3BBZzVLRlFWb0xSNFRBeDBVS1U5aUg2NkYvRmhXb01KdnBLSjhUc09WbDlLRlJrdjJ1OVNKSjFRb2I1dlBUVTk3K1ExYTFzNm1uZmtLQW5zaHZTY0puS3B6VXJyMEl6YVVqeVhsQ1NYK3ozOVhiU2NzUGZwVEtta0NoQXVoY2dtV3A0TGlIZHlDd2tmU2s3cVNxdEltbDhuUVdKVSsxTlhUa1NDbm5aWGcrZFdtVG9PNjQ1S0dYSHVxUG5pVGZrMU1BcFlhc3hlWitTWks3UjhXNUlselFpQVZySHREYkhmN2xJNzFtb3h2cmI4UjE4K0hPdXF0aitOalFpQVEvTVdTek83WTlXTDJKS2szM3BUcUdQT3o2dEdJN3Y4MUZiYTFKbHZKU3d3QldEaU0wdWJzYlNtMXBNZ0RkSXZiM3lNOElnOU9VRlp2WFdOVGxxY0NmanRpSDgyT05jTGRhYzdvQldSeHlmVkdIQmY0MnpoWUkrNlZoU2htcXR3NWgyWHJwK0hsTnNBU2JKYWxjNGZBcFZZT1k4RXJxT3ZNbGc3R240ZDcxOWEyVlBXczU1SGZpUk9WWDd2Nm85ajUydzFUTU9EMU5MV0FKcUd5UTRpUHllaGV6NmFPVjJsZlllYkRnYkNmNjFzaDRXNU1pRzJ5bXp5VlNpUXZ6cUt1UGFMZmQ0WU1yamYvbTU5SStZNEY4Z3B2b05DY09lSmU4R1BsZW1KczV2cDRFelVnWkhCUkI4SHY4Njl1aFV3QXNXVDZRMkxMMXVSc05DdmFrNlNUMXRCNmxzNms5SzJlY1lOWTVGUndpL0hQbnZSbnF2a2VtZGZTYklIWVRLUUhOcytjcTFzdFMxeW8xVWY5OTJ1RDU0dW84TDJ5RCtReHdRTWRyU3VQeENmcEowdjNWZlJkd0wxQkFBdVFTU2EzZlRUbS91dzdFOE5DNFVrSEtFNnZPdlhVdzJmRC92ZUpzckwyZGwzYVhTMmNFbUs2WEYyUzYyaG43N0YyT1FLYlVPZlF6TnczWUJ2SG03eVhUcVZQU3c1QlQ3cjc3V0dWVFNVUzN6SHVOVlBCZ1ZZaGdsRUJUMXRoM0lEWkZnWlJCbGxyZ1ZmSW0rM2ZIQ1FvKzFxQlJVdzNMZWppckUvcWxaZXc2ckdmakd0K2xyQkNJbzMwWEVwYmtVcjZTU0diVXhpK2NZRy9yQVp1R296a2duOXhCemtHbHFPRkhVSjRJVEcxUWE4MjM3Q2hjcjBTd3pCMFFJS3lLb2lvWlExSXFZQnVidUt0bFpNdzRGcGVlOXorcmRaY1ZqcktZNkpkTFNOMlQvR1N3SnRFaUZzMGQ1VFdhc0ovRzdKcXpPNi9JYXJNUjdTanRHc0haRjhmRUJSRlM0ekVlNk9aVjNZRk5YU0lzZ0Q4UGo5ZGNJc3I2aUs5VWdRcUpIQzBvdlNDSEomZlBUVk53SkQ2ZVB6M3FoZXhlUG5jRFZ2Yi8wPQ==' },
    });
    timings.fetchTime = performance.now() - fetchStartTime;

    const html = response.data;
    const processStartTime = performance.now();
    const $ = cheerio.load(html);

    let title: string | undefined;
    let author: string | undefined;
    let thumbnail: string | undefined;
    let videoUrl: string | null = null;
    let imageUrl: string | undefined;

    // JSON embedded data
    let ldJsonData: any = null;
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const scriptContent = $(el).html();
        if (scriptContent) {
          const jsonData = JSON.parse(scriptContent);
          if (jsonData["@type"] && (jsonData["@type"].includes("Video") || jsonData["@type"].includes("Pin"))) {
            ldJsonData = jsonData;
            return false;
          }
        }
      } catch (e) {}
    });

    if (ldJsonData) {
      title = ldJsonData.name || ldJsonData.headline;
      author = ldJsonData.author?.name || ldJsonData.creator?.name;
      thumbnail = ldJsonData.thumbnailUrl || ldJsonData.image;
      imageUrl = ldJsonData.image || ldJsonData.thumbnailUrl;
      if (!videoUrl) videoUrl = ldJsonData.contentUrl || ldJsonData.embedUrl || null;
    } else {
      // Fallback OG tags
      thumbnail = $('meta[property="og:image"]').attr("content");
      imageUrl = thumbnail;
      const ogTitle = $('meta[property="og:title"]').attr("content");
      if (ogTitle) {
        title = ogTitle.split('|')[0].trim();
        author = $('meta[property="og:see_also"]').attr("href")?.split('/').filter(Boolean).pop() || undefined;
      }
    }

    // video tag fallback
    const videoTagSrc = $("video source[src], video[src]").attr("src");
    if (videoTagSrc && videoTagSrc.includes("pinimg.com")) videoUrl = videoTagSrc;

    // m3u8 -> mp4 conversion hint
    if (videoUrl && videoUrl.includes(".m3u8")) {
      videoUrl = videoUrl.replace("/hls/", "/expMp4/").replace(".m3u8", "_t1.mp4");
    }

    const media: CleanedMedia[] = [];
    if (videoUrl) media.push({ type: 'video', url: videoUrl });
    else if (imageUrl) media.push({ type: 'photo', url: imageUrl });

    timings.processTime = performance.now() - processStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    if (media.length === 0) return { status: 'not_found', timings };

    return {
      status: 'success',
      author: author?.trim(),
      title: title?.trim(),
      thumbnail: thumbnail?.trim(),
      media,
      timings,
    };
  } catch (error: any) {
    console.error("[Pinterest Scraper Error]", error.message);
    timings.totalTime = performance.now() - totalStartTime;
    return { status: 'fetch_error', timings };
  }
}

export default async function handler(url: string) {
  return await scrapePinterest(url);
}