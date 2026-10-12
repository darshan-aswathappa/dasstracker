/**
 * Dry-run the application flow against one real posting.
 *
 * This is the way to verify the automation before arming it: it signs in and
 * fills every step exactly as the live path would, then stops on the Review
 * page without pressing Submit. Nothing is submitted by this script, ever —
 * the dry-run switch is forced on here regardless of the environment.
 *
 *   npm run apply:probe              # newest entry-level matched job
 *   npm run apply:probe -- 550021    # a specific card id
 *
 * Screenshots of each step land in data/apply/ so a wrong selection can be
 * seen rather than guessed at.
 */

import { loadEnv } from '../src/core/env.js';
import { createApp } from '../src/server/app.js';
import { createApplicator, applicatorConfigFromEnv } from '../src/core/applicator.js';
import { loadApplicationProfile } from '../src/core/profile.js';

loadEnv();

async function main() {
  const ctx = createApp();
  const { store, log } = ctx;
  const wanted = process.argv[2];

  const job = wanted
    ? store.recentJobs(500).find((j) => j.cardId === wanted)
    : store.recentJobs(500).find((j) => j.entryLevel === true && j.matched);

  if (!job) {
    console.error(
      wanted
        ? `No stored job with card id ${wanted}.`
        : 'No entry-level matched job in the database to probe.',
    );
    process.exit(1);
  }

  const profile = loadApplicationProfile();
  const config = applicatorConfigFromEnv(process.env, profile);
  if (!config) {
    console.error('Set TALEO_USERNAME and TALEO_PASSWORD in .env before probing.');
    process.exit(1);
  }

  log(`Probing: ${job.title.trim()} (${job.cardId})`);
  log(`Resume to attach: ${profile.resumeFileName}`);
  log(`Apply URL: ${job.applyUrl}`);

  // Forced: a probe must never be able to submit, whatever the .env says.
  const applicator = createApplicator({ ...config, dryRun: true }, log);
  const result = await applicator.apply(job);

  log(`Outcome: ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`);
  for (const shot of result.screenshots) log(`  screenshot: ${shot}`);

  if (result.outcome === 'dry_run') {
    log('Reached the Review page with everything filled. Nothing was submitted.');
  } else {
    log('The flow did not reach the Review page; check the screenshots above.');
  }

  store.close();
  process.exit(result.outcome === 'dry_run' ? 0 : 1);
}

main().catch((err) => {
  console.error('apply-probe failed:', err);
  process.exit(1);
});
