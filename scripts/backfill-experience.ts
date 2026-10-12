/**
 * One-off backfill for jobs stored before experience tracking existed.
 *
 * Two passes, cheapest first:
 *   1. The search API listing — one request per page, covers every posting
 *      still open. This is the same data a normal scan reads.
 *   2. The job detail page, for whatever the listing did not cover. Delisted
 *      postings serve the careers search page instead of their own, so their
 *      band is simply gone; those jobs keep a blank experience and no badge.
 *
 * Then every job with a band and no verdict goes to Jev. Safe to re-run: jobs
 * already carrying a band or a verdict are skipped.
 *
 *   npm run backfill            # full run
 *   npm run backfill -- --dry   # report what it would do, change nothing
 *   npm run backfill -- --skip-pages   # listing pass only, no page fetches
 */

import { loadEnv } from '../src/core/env.js';
import { createApp } from '../src/server/app.js';
import { fetchJobs } from '../src/core/fetcher.js';
import { fetchExperience } from '../src/core/experience.js';
import { classifyPendingJobs } from '../src/core/classify.js';

loadEnv();

/** Courtesy delay between detail-page fetches; 3DS is not ours to hammer. */
const PAGE_DELAY_MS = 350;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dry = process.argv.includes('--dry');
  const skipPages = process.argv.includes('--skip-pages');
  const ctx = createApp();
  const { store, log } = ctx;

  const missing = store.jobsMissingExperience();
  log(`${store.countJobs()} jobs stored; ${missing.length} without an experience band.`);

  // --- Pass 1: the search API listing ---
  const config = ctx.getConfig();
  const listed = await fetchJobs(
    { lang: config.lang, type: config.type, country: config.country },
    { pageSize: 50, maxPages: 20 },
  );
  const bands = new Map(listed.map((j) => [j.cardId, j.experience]));
  log(`Listing returned ${listed.length} open postings.`);

  let fromListing = 0;
  const stillMissing = [];
  for (const job of missing) {
    const band = bands.get(job.cardId);
    if (band) {
      if (!dry) store.setExperience(job.cardId, band);
      fromListing++;
    } else {
      stillMissing.push(job);
    }
  }
  log(`Pass 1 (listing): filled ${fromListing}; ${stillMissing.length} left.`);

  // --- Pass 2: detail pages ---
  let fromPages = 0;
  let delisted = 0;
  if (skipPages) {
    log(`Pass 2 (detail pages): skipped by --skip-pages.`);
  } else {
    for (const [i, job] of stillMissing.entries()) {
      const band = await fetchExperience(job.url);
      if (band) {
        if (!dry) store.setExperience(job.cardId, band);
        fromPages++;
      } else {
        delisted++;
      }
      if (i % 25 === 24) log(`  …${i + 1}/${stillMissing.length} pages checked`);
      await sleep(PAGE_DELAY_MS);
    }
    log(`Pass 2 (detail pages): filled ${fromPages}; ${delisted} delisted, band unrecoverable.`);
  }

  // --- Pass 3: classify ---
  if (dry) {
    log('Dry run: no rows written, no model calls made.');
  } else {
    const jev = ctx.buildJev();
    if (!jev.configured) {
      log('Jev not configured (set OPENROUTER_API_KEY) — bands stored, nothing classified.');
    } else {
      const decided = await classifyPendingJobs(store, jev, () => new Date().toISOString(), log);
      log(`Pass 3 (Jev): decided ${decided} job(s).`);
    }
  }

  const counts = store.classificationCounts();
  log(
    `Final: ${counts.entry} entry level, ${counts.senior} above 3 years, ` +
      `${counts.undecided} undecided, ${counts.pending} unclassified.`,
  );
  store.close();
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
