/**
 * Fetches job postings from the public 3DS careers search API.
 *
 * The 3DS careers site is a Nuxt SPA that loads jobs client-side from an
 * unauthenticated JSON endpoint. We call that endpoint directly (no browser,
 * no auth). Results are ordered newest-first so pagination can stop early once
 * we reach jobs we have already seen.
 */

import type { Job } from './types.js';

const API_BASE = 'https://www.3ds.com/apisearch/card_search_api';
/** Career section that serves an apply flow for any requisition id. */
const APPLY_BASE = 'https://talentacquisition.3ds.com/careersection/ca/jobapply.ftl';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface FetchQuery {
  lang: string;
  type: string; // e.g. "Regular"
  country: string; // e.g. "United States"
}

/** Build the `q=` search expression for the given filters. */
export function buildQueryExpression(q: FetchQuery): string {
  return (
    `#all card_content_lang:${q.lang}   ` +
    `(card_content_type="career")  ` +
    `card_content_categories:("type/${q.type}" AND "country/${q.country}")`
  );
}

/** Build the full request URL for one page of results. */
export function buildUrl(q: FetchQuery, offset: number, pageSize: number): string {
  const params = new URLSearchParams({
    q: buildQueryExpression(q),
    s: 'desc(card_content_start_datetime)',
    b: String(offset),
    hf: String(pageSize),
    output_format: 'json',
  });
  return `${API_BASE}?${params.toString()}`;
}

/**
 * Read the first value for a given meta name from a hit's `metas` array.
 * Meta names can repeat (e.g. `meta_cat`); this returns the first match.
 */
function metaValue(metas: Array<{ name: string; value: unknown }>, name: string): string {
  const found = metas.find((m) => m.name === name);
  return found && found.value != null ? String(found.value) : '';
}

/**
 * Convert the 3DS timestamp format `YYYY/MM/DD HH:MM:SS` (UTC) into an ISO
 * string. Returns empty string when the input is missing/unparseable.
 */
export function parseTimestamp(raw: string): string {
  const m = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return '';
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * Pull the value following a labeled segment out of the `content_categories`
 * string, e.g. `Category/Sales Type/Regular Country/United States City/...`.
 * Segments are space-separated with values that may themselves contain spaces,
 * so we split on the known label prefixes.
 */
function extractCategoryField(categories: string, label: string): string {
  const labels = ['Category', 'Type', 'Country', 'City', 'Products', 'Year'];
  const others = labels.filter((l) => l !== label).join('|');
  const re = new RegExp(`${label}/(.+?)(?:\\s+(?:${others})/|$)`);
  const m = categories.match(re);
  return m ? m[1].trim() : '';
}

/**
 * The longest posting body we keep. Descriptions run to a few thousand
 * characters; the cap is there so one pathological posting cannot bloat the
 * database or a model prompt.
 */
const MAX_DESCRIPTION_CHARS = 8000;

/** The handful of entities the 3DS summaries actually contain. */
const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&rsquo;': '\u2019',
  '&lsquo;': '\u2018',
  '&ldquo;': '\u201c',
  '&rdquo;': '\u201d',
  '&eacute;': '\u00e9',
  '&egrave;': '\u00e8',
};

/**
 * Turn the posting body's HTML into plain text.
 *
 * The API returns `content_summary` as a blob of markup. Only the words
 * matter here — they are read by the role classifier and nothing renders
 * them — so tags are dropped, block boundaries become spaces, and the handful
 * of entities the summaries use are decoded. Runs once per job at fetch time.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  const text = html
    // Script/style bodies are never prose; drop them whole.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text;
}

/**
 * The apply link for a requisition, for the roughly one posting in twenty
 * where the search API returns no Apply CTA at all. The pattern is the one the
 * careers site itself produces, with its source tag.
 */
export function deriveApplyUrl(cardId: string): string {
  return `${APPLY_BASE}?job=${encodeURIComponent(cardId)}&lang=en&src=CWS-10080`;
}

/** Map a single raw API hit into a normalized Job. */
export function parseHit(hit: { metas?: Array<{ name: string; value: unknown }> }): Job | null {
  const metas = hit.metas ?? [];
  const cardId = metaValue(metas, 'card_id');
  const title = metaValue(metas, 'content_title');
  if (!cardId || !title) return null;

  const categories = metaValue(metas, 'content_categories');

  return {
    cardId,
    title,
    url: metaValue(metas, 'content_cta_1_url'),
    applyUrl: metaValue(metas, 'content_cta_2_url') || deriveApplyUrl(cardId),
    location:
      metaValue(metas, 'content_info_2_value') ||
      extractCategoryField(categories, 'City'),
    category: extractCategoryField(categories, 'Category'),
    products: extractCategoryField(categories, 'Products'),
    experience: extractCategoryField(categories, 'Year'),
    description: htmlToText(metaValue(metas, 'content_summary')),
    postedAt: parseTimestamp(metaValue(metas, 'content_start_datetime')),
  };
}

/** Parse a full API JSON response body into a list of Jobs. */
export function parseResponse(body: unknown): Job[] {
  const hits = (body as { hits?: unknown[] })?.hits;
  if (!Array.isArray(hits)) return [];
  const jobs: Job[] = [];
  for (const hit of hits) {
    const job = parseHit(hit as { metas?: Array<{ name: string; value: unknown }> });
    if (job) jobs.push(job);
  }
  return jobs;
}

export interface FetchOptions {
  pageSize?: number;
  maxPages?: number;
  /**
   * Called with each page's jobs. Return true to stop paginating (e.g. once a
   * page contains only already-seen jobs). When omitted, all pages up to
   * maxPages are fetched.
   */
  stopWhen?: (pageJobs: Job[]) => boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch newest-first job pages, accumulating unique jobs. Stops when a page is
 * empty, when `stopWhen` returns true, or when maxPages is reached.
 */
export async function fetchJobs(
  query: FetchQuery,
  options: FetchOptions = {},
): Promise<Job[]> {
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 3;
  const doFetch = options.fetchImpl ?? fetch;
  const all: Job[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const url = buildUrl(query, page * pageSize, pageSize);
    const res = await doFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`3DS API returned HTTP ${res.status} for ${url}`);
    }
    const body = await res.json();
    const jobs = parseResponse(body);
    if (jobs.length === 0) break;

    for (const job of jobs) {
      if (!seen.has(job.cardId)) {
        seen.add(job.cardId);
        all.push(job);
      }
    }

    if (options.stopWhen && options.stopWhen(jobs)) break;
    if (jobs.length < pageSize) break; // last page
  }

  return all;
}
