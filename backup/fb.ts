import { parse } from 'json-custom-numbers';
import { decode } from 'entities';
import path from 'path';

const EAAU_TOKENS = ['EAAAAUaZA8jlABPgzzfTGw2WbAMB4R4iZBCubQXXp3nJ5YlgjkUIZCZBhUz0658Cvix8HnSpNhZCTs6OncyDhuAxcj4F383NkPto1aHNo9qcmd9nabHW5GjaLtSeKYzm7BaxSyZCL74yVUzzO3TPv9FnL1xZBXHtMgrU7fYqkXRLxCxrr7kD64ZBJKZBnNw26AQpUACwZDZD', 'token_2'];
let currentTokenIndex = 0;

type CleanedMedia = {
  type: 'video' | 'photo';
  url: string;
  thumbnail?: string;
};

export type ExtractionResult = {
  status: 'success' | 'not_found' | 'fetch_error' | 'invalid_url' | 'api_params_outdated';
  author?: string | null;
  title?: string;
  thumbnail?: string;
  media?: Omit<CleanedMedia, 'thumbnail'>[];
  timings: {
    fetchTime: number;
    processTime: number;
    totalTime: number;
  };
};

interface FacebookTitleInfo {
  title: string;
  author: string | null;
}

const FETCH_TIMEOUT = 8_000;
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
};

function armTimeout(ctrl: AbortController, ms = FETCH_TIMEOUT) {
  const t = setTimeout(() => ctrl.abort(), ms);
  (t as any).unref?.();
}

function convertToMobileUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    if (u.hostname.startsWith('m.') || u.hostname === 'fb.watch' || !u.hostname.endsWith('facebook.com')) {
      return urlStr;
    }
    u.hostname = 'm.facebook.com';
    return u.href;
  } catch {
  }
  return urlStr;
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  const cleanedStr = str.trim().replace(/(\r\n|\n|\r)/gm, " ");
  if (cleanedStr.length <= maxLength) return cleanedStr;
  return cleanedStr.substring(0, maxLength - 1) + '…';
}

function splitTitleAuthor(raw: string): FacebookTitleInfo {
  const byAuthorMatch = raw.match(/(.+) \| By (.+)/i);
  if (byAuthorMatch?.[1] && byAuthorMatch?.[2]) {
    return { title: truncate(byAuthorMatch[1].trim(), 250), author: truncate(byAuthorMatch[2].replace(/\| Facebook/i, '').trim(), 100) };
  }
  const audioParts = raw.split('·').map(p => p.trim()).filter(Boolean);
  if (audioParts.length > 1 && audioParts[1].toLowerCase().includes('original audio')) {
    return { title: truncate(audioParts[1], 250), author: truncate(audioParts[0], 100) };
  }
  const reelByMatch = raw.match(/(?:reel|video) by (.+)/i);
  if (reelByMatch?.[1]) {
    const titlePart = raw.split("by")[0].trim().replace(/\|/g, '').trim() || 'Reel/Video';
    return { title: truncate(titlePart, 250), author: truncate(reelByMatch[1], 100) };
  }
  const isMetadata = (part: string) => /\d+([.,]\d+)?[kmb]?\s+(views|reactions|likes|followers|shares)|facebook/i.test(part.toLowerCase());
  const contentParts = raw.split('|').map(p => p.trim()).filter(p => p && !isMetadata(p));
  if (contentParts.length === 0) return { title: truncate(raw, 250), author: null };
  if (contentParts.length === 1) {
    const dashParts = contentParts[0].split(' - ').map(p => p.trim());
    return dashParts.length > 1 ? { author: truncate(dashParts[0], 100), title: truncate(dashParts.slice(1).join(' - '), 250) } : { title: truncate(contentParts[0], 250), author: null };
  }
  if (contentParts.length >= 2) {
    let author = contentParts[contentParts.length - 1];
    let title = contentParts.slice(0, contentParts.length - 1).join(' | ');
    if (title.length < author.length) [title, author] = [author, title];
    return { title: truncate(title, 250), author: truncate(author, 100) };
  }
  return { title: truncate(raw, 250), author: null };
}

async function fetchAndParseTitleFromPage(
  url: string,
  userAgent: string,
  byteLimit: number,
  controller: AbortController
): Promise<FacebookTitleInfo | null> {
  const headers = { ...BROWSER_HEADERS, 'User-Agent': userAgent, 'Range': `bytes=0-${byteLimit}` };
  try {
    const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    if ((res.status !== 200 && res.status !== 206) || !res.body || res.url.includes('/login')) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const ogRe = /<meta\s+property=["']og:title["']\s+content=["']([^"]+)["']/i;
    const titleRe = /<title>([^<]+)<\/title>/i;
    let ogTitle: string | null = null;
    let htmlTitle: string | null = null;
    let bytesRead = 0;
    let previousTail = '';
    while (true) {
      if (controller.signal.aborted) {
        await reader.cancel();
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      const searchBuffer = previousTail + decoder.decode(value, { stream: true });
      if (!ogTitle) ogTitle = searchBuffer.match(ogRe)?.[1] ?? null;
      if (!htmlTitle) htmlTitle = searchBuffer.match(titleRe)?.[1] ?? null;
      if ((ogTitle && htmlTitle) || bytesRead > byteLimit) {
        await reader.cancel();
        break;
      }
      previousTail = searchBuffer.slice(-100);
    }
    const rawDetectedTitle = ogTitle || htmlTitle;
    if (rawDetectedTitle) {
      return splitTitleAuthor(decode(rawDetectedTitle));
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchFacebookMetadata(inputUrl: string): Promise<FacebookTitleInfo> {
  const googleBotUserAgent = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const mobileUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const genericTitles = ['Facebook', 'Facebook Watch', 'Discover Popular Videos', 'Log in to Facebook'];
  const isResultGood = (res: FacebookTitleInfo | null): boolean => !!res && !genericTitles.some(t => res.title.trim() === t);
  const strategies = [
    { name: 'Mobile', url: convertToMobileUrl(inputUrl), userAgent: mobileUserAgent },
    { name: 'Desktop (Googlebot)', url: inputUrl, userAgent: googleBotUserAgent },
  ];
  const createStrategyPromise = (strategy: typeof strategies[0]): Promise<FacebookTitleInfo> => new Promise(async (resolve, reject) => {
    const controller = new AbortController();
    armTimeout(controller);
    const result = await fetchAndParseTitleFromPage(strategy.url, strategy.userAgent, 75 * 1024, controller);
    if (isResultGood(result)) resolve(result!);
    else reject(new Error(`Generic or no title from ${strategy.name}`));
  });
  try {
    return await Promise.any(strategies.map(createStrategyPromise));
  } catch (e: any) {
    throw new Error('No valid title found after trying all strategies.');
  }
}

async function logResponseToFile(fileName: string, data: any) {
  try {
    const dir = path.join(import.meta.dir, 'logs');
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    await Bun.write(path.join(dir, fileName), content);
  } catch (writeError) {
    console.error(`[Facebook] Failed to write log to ${fileName}:`, writeError);
  }
}

class FacebookUtils {
  public static isTokenMissing = () => !EAAU_TOKENS || EAAU_TOKENS.length === 0 || EAAU_TOKENS.every(t => !t);
  private static getNextToken = (): string => {
    if (this.isTokenMissing()) {
      throw new Error("EAAU_TOKENS array is empty or contains no valid tokens.");
    }
    const token = EAAU_TOKENS[currentTokenIndex];
    currentTokenIndex = (currentTokenIndex + 1) % EAAU_TOKENS.length;
    return token;
  };
  private static makeParsable = (body: string) => body.replace(/for\s*\(\s*;\s*\)\s*;\s*/, '');
  public static parseFromBody = (body: string) => {
    try {
      return parse(this.makeParsable(body));
    } catch {
      return body;
    }
  };
  public static async postToGraphQL(data: Record<string, any>): Promise<string> {
    const tokenToUse = this.getNextToken();
    const formData = new URLSearchParams(data);
    const response = await fetch('https://graph.facebook.com/graphql', {
      method: 'POST',
      headers: {
        'authorization': `OAuth ${tokenToUse}`,
        'user-agent': '[FBAN/FB4A;FBAV/417.0.0.33.65;FBBV/480085463;FBDM/{density=2.75,width=1080,height=2029};FBLC/vi_VN;FBRV/0;FBPN/com.facebook.katana;FBDV/MI 8 SE;FBSV/9;FBCA/armeabi-v7a:armeabi;]',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    if (!response.ok) throw new Error(`GraphQL request failed: ${response.status}`);
    return await response.text();
  }
}

class FacebookMediaScraper {
  async fetchMedia(url: string): Promise<CleanedMedia[] | null> {
    const previewText = await FacebookUtils.postToGraphQL({
      fb_api_req_friendly_name: 'ComposerLinkPreviewQuery',
      client_doc_id: '89598650511870084207501691272',
      variables: JSON.stringify({ params: { url } })
    });
    const previewResponse = FacebookUtils.parseFromBody(previewText);
    await logResponseToFile('fb_resp1_preview.json', previewResponse);
    const previewData = Array.isArray(previewResponse) ? previewResponse[0].data : previewResponse.data;
    if (previewData?.link_preview?.story_attachment?.style_infos?.[0]?.fb_shorts_story) {
      return this.formatPreviewMedia(previewData);
    }
    const shareParamsString = previewData?.link_preview?.share_scrape_data;
    if (!shareParamsString) throw new Error('Could not extract share_scrape_data. Content may be private or a text-only post.');
    const shareParams = parse(shareParamsString);
    const { post_id, node_id } = { post_id: shareParams?.share_params?.[0]?.toString(), node_id: previewData?.link_preview?.story?.id };
    if (node_id && post_id) {
      const mobileApiText = await FacebookUtils.postToGraphQL({
        fb_api_req_friendly_name: 'FetchGraphQLStoryAndMediaFromTokenQuery',
        client_doc_id: '14968485422525517963281561600',
        variables: JSON.stringify({ node_id, media_token: `pcb.${post_id}` }),
      });
      const mobileApiData = FacebookUtils.parseFromBody(mobileApiText);
      await logResponseToFile('fb_resp2_media.json', mobileApiData);
      const mobileData = Array.isArray(mobileApiData) ? mobileApiData[0].data : mobileApiData.data;
      if (mobileData?.mediaset?.media?.edges?.length > 0) {
        return this.formatMobileMedia(mobileData);
      }
      if (mobileData?.node?.attachments?.length > 0) {
        return this.formatNodeAttachmentMedia(mobileData);
      }
    }
    throw new Error('All media fetching methods failed. The content may be private or unsupported.');
  }

  private formatPreviewMedia(data: any): CleanedMedia[] {
    const attachment = data.link_preview.story_attachment;
    const video = attachment.style_infos[0].fb_shorts_story.short_form_video_context.video;
    return [{ type: 'video' as const, url: video.original_download_url_hd || video.original_download_url_sd, thumbnail: attachment.media.image.uri }];
  }

  private formatMobileMedia(data: any): CleanedMedia[] {
    return data.mediaset.media.edges.map((item: any) => {
      const node = item.node;
      if (node.__typename === 'Photo' && node.image?.uri) {
        return { type: 'photo' as const, url: node.image.uri, thumbnail: node.image.uri };
      }
      if (node.__typename === 'Video' && (node.playable_url || node.hd_playable_url)) {
        return { type: 'video' as const, url: node.hd_playable_url || node.playable_url, thumbnail: node.image?.uri };
      }
      return null;
    }).filter(Boolean) as CleanedMedia[];
  }

  private formatNodeAttachmentMedia(data: any): CleanedMedia[] {
    const attachments = data.node?.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }
    return attachments.map((attachment: any) => {
      const media = attachment.media;
      if (!media || media.__typename !== 'Video') {
        return null;
      }
      const hdUrl = media.playableUrlHdString || media.hd_playable_url;
      const sdUrl = media.playable_url;
      const url = hdUrl || sdUrl;
      if (!url) {
        return null;
      }
      const thumbnail = media.image?.uri;
      return { type: 'video' as const, url: url, thumbnail: thumbnail, };
    }).filter(Boolean) as CleanedMedia[];
  }
}

export async function scrapeFacebook(url: string, options: { metadata?: boolean } = {}): Promise<ExtractionResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = Bun.nanoseconds();
  const toMs = (ns: number) => ns / 1_000_000;
  if (options.metadata) {
    console.log(`[Facebook] Metadata-only request for URL: ${url}`);
    try {
      const fetchStartTime = Bun.nanoseconds();
      const { title, author } = await fetchFacebookMetadata(url);
      timings.fetchTime = toMs(Bun.nanoseconds() - fetchStartTime);
      timings.totalTime = toMs(Bun.nanoseconds() - totalStartTime);
      return { status: 'success', title, author, timings, media: [] };
    } catch (error: any) {
      timings.totalTime = toMs(Bun.nanoseconds() - totalStartTime);
      return { status: 'not_found', timings, title: 'Could not fetch metadata' };
    }
  }
  if (FacebookUtils.isTokenMissing()) {
    console.error("[Facebook] EAAU_TOKENS array is empty or not set correctly in the script.");
    timings.totalTime = toMs(Bun.nanoseconds() - totalStartTime);
    return { status: 'api_params_outdated', timings };
  }
  try {
    const fetchStartTime = Bun.nanoseconds();
    const scraper = new FacebookMediaScraper();
    const mediaPromise = scraper.fetchMedia(url);
    const metadataPromise = fetchFacebookMetadata(url).catch(() => {
      return { title: 'Facebook Post', author: 'Unknown' };
    });
    const [media, metadata] = await Promise.all([mediaPromise, metadataPromise]);
    timings.fetchTime = toMs(Bun.nanoseconds() - fetchStartTime);
    if (!media || media.length === 0) {
      throw new Error("No media attachments found in the final processed data.");
    }
    const processStartTime = Bun.nanoseconds();
    const { title, author } = metadata;
    const thumbnail = media.find(m => m.thumbnail)?.thumbnail;
    const finalMedia = media.map(({ thumbnail: _, ...rest }) => rest);
    timings.processTime = toMs(Bun.nanoseconds() - processStartTime);
    timings.totalTime = toMs(Bun.nanoseconds() - totalStartTime);
    return { status: 'success', author, title, thumbnail, media: finalMedia, timings };
  } catch (error: any) {
    timings.totalTime = toMs(Bun.nanoseconds() - totalStartTime);
    if (error.message.includes('private') || error.message.includes('unsupported') || error.message.includes('No media attachments')) {
      return { status: 'not_found', timings };
    }
    return { status: 'fetch_error', timings };
  }
}

export default async function handler(url: string) {
  return await scrapeFacebook(url);
}