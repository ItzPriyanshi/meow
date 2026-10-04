import { performance } from 'perf_hooks';

const INSTAGRAM_GRAPHQL_URL = 'https://www.instagram.com/api/graphql';
const INSTAGRAM_HEADERS = {
  'Accept': '/',
  'Accept-Language': 'en-US,en;q=0.5',
  'Content-Type': 'application/x-www-form-urlencoded',
  'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
  'X-CSRFToken': 'RVDUooU5MYsBbS1CNN3CzVAuEP8oHB52',
  'X-IG-App-ID': '1217981644879628',
  'X-FB-LSD': 'AVqbxe3J_YA',
  'X-ASBD-ID': '129477',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36',
};

const STATIC_REQUEST_PARAMS = {
  av: '0',
  __d: 'www',
  __user: '0',
  __a: '1',
  __req: '3',
  __hs: '19624.HYP:instagram_web_pkg.2.1..0.0',
  dpr: '3',
  __ccg: 'UNKNOWN',
  __rev: '1008824440',
  __s: 'xf44ne:zhh75g:xr51e7',
  __hsi: '7282217488877343271',
  __dyn: '7xeUmwlEnwn8K2WnFw9-2i5U4e0yoW3q32360CEbo1nEhw2nVE4W0om78b87C0yE5ufz81s8hwGwQwoEcE7O2l0Fwqo31w9a9x-0z8-U2zxe2GewGwso88cobEaU2eUlwhEe87q7-0iK2S3qazo7u1xwIw8O321LwTwKG1pg661pwr86C1mwraCg',
  __csr: 'gZ3yFmJkillQvV6ybimnG8AmhqujGbLADgjyEOWz49z9XDlAXBJpC7Wy-vQTSvUGWGh5u8KibG44dBiigrgjDxGjU0150Q0848azk48N09C02IR0go4SaR70r8owyg9pU0V23hwiA0LQczA48S0f-x-27o05NG0fkw',
  __comet_req: '7',
  lsd: 'AVqbxe3J_YA',
  jazoest: '2957',
  __spin_r: '1008824440',
  __spin_b: 'trunk',
  __spin_t: '1695523385',
  fb_api_caller_class: 'RelayModern',
  fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
  server_timestamps: 'true',
  doc_id: '10015901848480474',
};

const STATIC_REQUEST_BODY_PART = new URLSearchParams(STATIC_REQUEST_PARAMS).toString();

const SHORTCODE_REGEX = /(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/;

type IG_GraphQLResponseDto = {
  data?: {
    xdt_shortcode_media?: any;
  };
};

type CleanedMedia = {
  type: 'video' | 'photo';
  url: string;
};

export type ExtractionResult = {
  status: 'success' | 'not_found' | 'fetch_error' | 'invalid_url';
  author?: string;
  title?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  timings: {
    fetchTime: number;
    processTime: number;
    totalTime: number;
  };
};

function getPostShortcode(url: string): string | null {
  const match = url.match(SHORTCODE_REGEX);
  return match ? match[1] : null;
}

function generateRequestBody(shortcode: string): string {
  const variables = {
    shortcode,
    fetch_comment_count: null,
    fetch_related_profile_media_count: null,
    parent_comment_count: null,
    child_comment_count: null,
    fetch_like_count: null,
    fetch_tagged_user_count: null,
    fetch_preview_comment_count: null,
    has_threaded_comments: false,
    hoisted_comment_id: null,
    hoisted_reply_id: null,
  };
  const dynamicPart = new URLSearchParams({ variables: JSON.stringify(variables) }).toString();
  return `${STATIC_REQUEST_BODY_PART}&${dynamicPart}`;
}

function extractMediaFromResponse(mediaData: any): CleanedMedia[] {
  if (!mediaData) return [];
  const carouselEdges = mediaData.edge_sidecar_to_children?.edges;
  if (carouselEdges) {
    return carouselEdges.flatMap((edge: any) => extractMediaFromResponse(edge.node));
  }
  if (mediaData.is_video) {
    return mediaData.video_url ? [{ type: 'video', url: mediaData.video_url }] : [];
  }
  const highestQualityImageSrc = mediaData.display_resources?.at(-1)?.src;
  const displayUrl = mediaData.display_url;
  const finalImageUrl = highestQualityImageSrc || displayUrl;
  return finalImageUrl ? [{ type: 'photo', url: finalImageUrl }] : [];
}

export async function scrapeInstagram(url: string): Promise<ExtractionResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();
  const shortcode = getPostShortcode(url);
  if (!shortcode) {
    timings.totalTime = performance.now() - totalStartTime;
    return { status: 'invalid_url', timings };
  }

  try {
    const fetchStartTime = performance.now();
    const response = await fetch(INSTAGRAM_GRAPHQL_URL, {
      method: 'POST',
      headers: INSTAGRAM_HEADERS,
      body: generateRequestBody(shortcode),
    });
    timings.fetchTime = performance.now() - fetchStartTime;

    if (!response.ok) {
      timings.totalTime = performance.now() - totalStartTime;
      return { status: 'fetch_error', timings };
    }

    const processStartTime = performance.now();
    const jsonResponse = (await response.json()) as IG_GraphQLResponseDto;
    const mediaData = jsonResponse.data?.xdt_shortcode_media;

    if (!mediaData) {
      timings.processTime = performance.now() - processStartTime;
      timings.totalTime = performance.now() - totalStartTime;
      return { status: 'not_found', timings };
    }

    const mediaUrls = extractMediaFromResponse(mediaData);
    if (mediaUrls.length === 0) {
      timings.processTime = performance.now() - processStartTime;
      timings.totalTime = performance.now() - totalStartTime;
      return { status: 'not_found', timings };
    }

    const authorName = mediaData.owner?.full_name || mediaData.owner?.username;
    const captionText = mediaData.edge_media_to_caption?.edges[0]?.node?.text;

    timings.processTime = performance.now() - processStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    return {
      status: 'success',
      author: authorName,
      title: captionText,
      thumbnail: mediaData.display_url,
      media: mediaUrls,
      timings,
    };
  } catch (error) {
    console.error("An unexpected error occurred during scraping:", error);
    timings.totalTime = performance.now() - totalStartTime;
    return { status: 'fetch_error', timings };
  }
}

export default async function handler(url: string) {
  return await scrapeInstagram(url);
}