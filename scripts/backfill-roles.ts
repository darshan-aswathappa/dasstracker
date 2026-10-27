/**
 * One-off backfill for jobs stored before role classification existed.
 *
 * Two passes:
 *   1. Fill in the posting body for stored jobs that have none, from the
 *      search API listing. A delisted posting is no longer in the listing, so
 *      its body is gone; those jobs are classified on title and category
 *      alone, which is what the classifier falls back to anyway.
 *   2. Ask Jev what kind of role each unclassified matched job is.
 *
 * This only fills in badges. It never applies to anything: auto-apply ignores
 * every job first seen before it was armed, and this script does not touch
 * that mark. Safe to re-run — a job already carrying a verdict is skipped.
 *
 *   npm run backfill:roles             # full run
 *   npm run backfill:roles -- --dry    # report what it would do, change nothing
 *   npm run backfill:roles -- --limit 50
 */

import { loadEnv } from '../src/core/env.js';
import { createApp } from '../src/server/app.js';
import { fetchJobs } from '../src/core/fetcher.js';
import { classifyPendingRoles } from '../src/core/classify.js';

loadEnv();

/** How many jobs one run will spend model calls on, unless told otherwise. */
const DEFAULT_LIMIT = 200;

/** Read `--limit N`, falling back to the default when absent or nonsense. */
export function parseLimit(argv: string[]): number {
  const at = argv.indexOf('--limit');
  if (at === -1) return DEFAULT_LIMIT;
  const value = Number(argv[at + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LIMIT;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const limit = parseLimit(process.argv);
  const ctx = createApp();
  const { store, log } = ctx;

  const pending = store.jobsNeedingRoleClassification(2, limit);
  log(`${store.countJobs()} jobs stored; ${pending.length} matched job(s) without a role.`);
  if (pending.length === 0) {
    store.close();
    return;
  }

  // --- Pass 1: posting bodies ---
  const config = ctx.getConfig();
  const listed = await fetchJobs(
    { lang: config.lang, type: config.type, country: config.country },
    { pageSize: 50, maxPages: 20 },
  );
  const bodies = new Map(listed.map((j) => [j.cardId, j.description]));
  log(`Listing returned ${listed.length} open postings.`);

  let filled = 0;
  let bodyless = 0;
  for (const job of pending) {
    if (job.description) continue;
    const body = bodies.get(job.cardId);
    if (body) {
      if (!dry) store.setDescription(job.cardId, body);
      filled++;
    } else {
      bodyless++;
    }
  }
  log(
    `Pass 1 (bodies): filled ${filled}; ${bodyless} delisted, ` +
      'to be judged on title and category alone.',
  );

  // --- Pass 2: classify ---
  if (dry) {
    log('Dry run: no rows written, no model calls made.');
  } else {
    const jev = ctx.buildJev();
    if (!jev.configured) {
      log('Jev not configured (set OPENROUTER_API_KEY) — bodies stored, nothing classified.');
    } else {
      const decided = await classifyPendingRoles(
        store,
        jev,
        () => new Date().toISOString(),
        log,
        limit,
      );
      log(`Pass 2 (Jev): decided ${decided} job(s).`);
    }
  }

  const counts = store.roleCounts();
  log(
    `Final: ${counts.ai} AI, ${counts.software} software, ${counts.other} neither, ` +
      `${counts.undecided} matched job(s) still without a verdict.`,
  );
  store.close();
}

main().catch((err) => {
  console.error('backfill-roles failed:', err);
  process.exit(1);
});
