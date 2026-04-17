import { createTrackedLink } from '@line-crm/db';

// Markdown-style [label](https://url) — label takes priority over auto-derived
const MD_LINK_REGEX = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
// Plain URLs (used for leftover URLs not wrapped in markdown syntax)
const URL_REGEX = /https?:\/\/[^\s"'<>\])}]+/g;

// URLs that should NOT be wrapped (internal/system URLs)
const SKIP_PATTERNS = [
  /\/t\/[0-9a-f-]{36}/,       // already a tracking link
  /\/line\/t\//,               // already a proxied tracking link
  /liff\.line\.me/,            // LIFF URLs
  /line\.me\/R\//,             // LINE deep links
  /line-crm-worker/,           // our own worker
];

function shouldSkip(url: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(url));
}

interface ExtractedLink {
  /** Exact substring from content to remove during cleanup — e.g. "[ラベル](https://...)" or "https://..." */
  matchedText: string;
  /** The URL to track */
  url: string;
  /** Optional author-provided label from markdown syntax */
  label?: string;
}

/**
 * Derive a button label from a raw URL string.
 * Uses the raw string (not URL.hostname) to preserve Unicode IDN — otherwise
 * `領収書.net` becomes `xn--lorw95b519a.net`.
 */
function deriveLabelFromUrl(url: string): string {
  let host = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const slashIdx = host.indexOf('/');
  if (slashIdx >= 0) host = host.slice(0, slashIdx);
  return host.length > 20 ? host.slice(0, 20) + '…' : host;
}

/** Extract all trackable links from the content, markdown-style first, then raw URLs. */
function extractLinks(content: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const claimedUrls = new Set<string>();

  for (const match of content.matchAll(MD_LINK_REGEX)) {
    const [matchedText, label, url] = match;
    const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
    if (shouldSkip(cleanUrl)) continue;
    links.push({ matchedText, url: cleanUrl, label: label.trim() });
    claimedUrls.add(cleanUrl);
  }

  for (const match of content.matchAll(URL_REGEX)) {
    const rawUrl = match[0].replace(/[.,;:!?)]+$/, '');
    if (shouldSkip(rawUrl) || claimedUrls.has(rawUrl)) continue;
    // Skip URLs already consumed by a markdown link (the `](url)` part overlaps)
    const mdMatch = content.slice(0, match.index).match(/\[[^\]\n]*\]\(\s*$/);
    if (mdMatch) continue;
    links.push({ matchedText: rawUrl, url: rawUrl });
    claimedUrls.add(rawUrl);
  }

  return links;
}

interface TrackedLinkInfo {
  matchedText: string;
  originalUrl: string;
  trackingUrl: string;
  label: string;
}

async function createTrackingLinks(
  db: D1Database,
  links: ExtractedLink[],
  workerUrl: string,
  friendId?: string,
): Promise<TrackedLinkInfo[]> {
  const out: TrackedLinkInfo[] = [];
  for (const link of links) {
    const record = await createTrackedLink(db, {
      name: `auto: ${(link.label ?? link.url).slice(0, 60)}`,
      originalUrl: link.url,
    });
    const friendParam = friendId ? `?f=${friendId}` : '';
    const trackingUrl = `${workerUrl}/t/${record.id}${friendParam}`;
    const rawLabel = link.label ?? deriveLabelFromUrl(link.url);
    // LINE button label limit is 20 chars
    const label = rawLabel.length > 20 ? rawLabel.slice(0, 20) + '…' : rawLabel;
    out.push({ matchedText: link.matchedText, originalUrl: link.url, trackingUrl, label });
  }
  return out;
}

/** Build a Flex bubble from text + tracked URLs */
function textToFlex(text: string, links: TrackedLinkInfo[]): string {
  let cleanText = text;
  for (const link of links) {
    cleanText = cleanText.split(link.matchedText).join('').trim();
  }
  cleanText = cleanText.replace(/\s{2,}/g, ' ').replace(/[👉🔗➡️]\s*$/g, '').trim();

  const bodyContents: unknown[] = [];
  if (cleanText) {
    bodyContents.push({
      type: 'text',
      text: cleanText,
      size: 'md',
      color: '#333333',
      wrap: true,
    });
  }

  const buttons = links.map((link) => ({
    type: 'button',
    action: {
      type: 'uri',
      label: link.label,
      uri: link.trackingUrl,
    },
    style: 'primary',
    color: '#1a1a2e',
    margin: 'sm',
  }));

  const bubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: bodyContents,
      paddingAll: '16px',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: buttons,
      paddingAll: '12px',
    },
  };

  return JSON.stringify(bubble);
}

export interface AutoTrackResult {
  messageType: string;
  content: string;
}

/**
 * Auto-wrap URLs in message content with tracking links.
 * For text messages with URLs, converts to Flex with button.
 * Supports markdown-style `[ラベル](https://...)` for custom button labels.
 * For flex messages, replaces URLs inline.
 */
export async function autoTrackContent(
  db: D1Database,
  messageType: string,
  content: string,
  workerUrl: string,
  friendId?: string,
): Promise<AutoTrackResult> {
  if (messageType === 'image') return { messageType, content };

  if (messageType === 'text') {
    const links = extractLinks(content);
    if (links.length === 0) return { messageType, content };
    const tracked = await createTrackingLinks(db, links, workerUrl, friendId);
    return {
      messageType: 'flex',
      content: textToFlex(content, tracked),
    };
  }

  // Flex messages → replace URLs inline in the JSON (markdown syntax is unlikely here)
  const urls = new Set<string>();
  for (const match of content.matchAll(URL_REGEX)) {
    const url = match[0].replace(/[.,;:!?)]+$/, '');
    if (!shouldSkip(url)) urls.add(url);
  }
  if (urls.size === 0) return { messageType, content };

  let result = content;
  for (const url of urls) {
    const record = await createTrackedLink(db, {
      name: `auto: ${url.slice(0, 60)}`,
      originalUrl: url,
    });
    const friendParam = friendId ? `?f=${friendId}` : '';
    const trackingUrl = `${workerUrl}/t/${record.id}${friendParam}`;
    result = result.split(url).join(trackingUrl);
  }
  return { messageType, content: result };
}
