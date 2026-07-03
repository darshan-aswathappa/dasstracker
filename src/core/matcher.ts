/**
 * Decides whether a job is a "technical role" worth notifying about.
 *
 * A job matches when its title contains any configured keyword (whole-word,
 * case-insensitive) OR its category is in the configured whitelist. Word-
 * boundary matching prevents false positives like "AI" inside "MAINTENANCE".
 */

import type { Job } from './types.js';

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a whole-word, case-insensitive matcher for a keyword. Boundaries are
 * defined by non-alphanumeric characters rather than \b, so multi-word phrases
 * ("full stack") and short acronyms ("AI", "ML") behave intuitively.
 */
function keywordRegex(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword.trim());
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
}

export interface MatchResult {
  matched: boolean;
  reasons: string[]; // human-readable explanations (keyword or category hits)
}

/** Evaluate a job against keyword + category-whitelist rules. */
export function matchJob(
  job: Job,
  keywords: string[],
  categoryWhitelist: string[],
): MatchResult {
  const reasons: string[] = [];
  const title = job.title ?? '';

  for (const kw of keywords) {
    if (!kw.trim()) continue;
    if (keywordRegex(kw).test(title)) {
      reasons.push(`title keyword "${kw}"`);
    }
  }

  const category = (job.category ?? '').toLowerCase();
  for (const cat of categoryWhitelist) {
    if (cat.trim() && category === cat.trim().toLowerCase()) {
      reasons.push(`category "${cat}"`);
    }
  }

  return { matched: reasons.length > 0, reasons };
}
