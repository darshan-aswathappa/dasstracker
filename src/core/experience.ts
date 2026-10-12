/**
 * Recovering the experience band from a 3DS job detail page.
 *
 * New jobs carry the band in the search API response (the `Year/` segment of
 * content_categories), so this is only needed to backfill jobs stored before
 * the field was tracked. The detail page renders it as a labeled pair:
 *
 *   <div class="key-jobdetails-item-title">Experience level:</div>
 *   <div class="key-jobdetails-item-description">0 to 3 years</div>
 *
 * A delisted posting still returns HTTP 200, but serves the careers search
 * page instead — which lists every band as a filter option. Keying off the
 * "Experience level:" label (not off the band text) is what keeps those pages
 * from yielding a wrong answer.
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const EXPERIENCE_RE =
  /Experience level:\s*<\/div>\s*<div[^>]*class="key-jobdetails-item-description"[^>]*>\s*([^<]+?)\s*</i;

const REQUEST_TIMEOUT_MS = 20_000;

/** Pull the labeled experience band out of a job detail page. '' if absent. */
export function parseExperienceFromHtml(html: string): string {
  const match = html.match(EXPERIENCE_RE);
  return match ? match[1].trim() : '';
}

/**
 * Fetch one job page and read its experience band. Returns '' for anything
 * that doesn't work out — a delisted posting, a dead link, a network blip —
 * because a missing band is an ordinary outcome here, not an error worth
 * aborting a backfill over.
 */
export async function fetchExperience(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!url.trim()) return '';
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return '';
    return parseExperienceFromHtml(await res.text());
  } catch {
    return '';
  }
}
