/**
 * Dry-run the application flow against one real posting.
 *
 * This is the way to verify the automation before arming it: it signs in and
 * fills every step exactly as the live path would, then stops on the Review
 * page without pressing Submit. Nothing is submitted by this script, ever —
 * the dry-run switch is forced on here regardless of the environment.
 *
 *   npm run apply:probe                      # newest entry-level matched job
 *   npm run apply:probe -- 550021            # a specific card id
 *   npm run apply:probe -- <full apply url>  # one exact link
 *
 * Screenshots of each step land in data/apply/ so a wrong selection can be
 * seen rather than guessed at.
 *
 * With --email-only it sends the notification instead, touching neither the
 * portal nor the database, so the mail can be read before any real
 * application depends on it:
 *
 *   npm run apply:probe -- 550021 --email-only           # the "Applied" mail
 *   npm run apply:probe -- 550021 --email-only --alert   # the "check by hand" one
 */

import { loadEnv } from '../src/core/env.js';
import { createApp } from '../src/server/app.js';
import { createApplicator, applicatorConfigFromEnv } from '../src/core/applicator.js';
import { applyNotifyList } from '../src/core/notifier.js';
import { loadApplicationProfile } from '../src/core/profile.js';

loadEnv();

async function main() {
  const ctx = createApp();
  const { store, log } = ctx;
  const wanted = process.argv[2];
  // A full URL probes exactly that link; a bare id probes that stored job.
  const asUrl = wanted && /^https?:\/\//i.test(wanted) ? wanted : null;
  const cardId = asUrl ? (new URL(asUrl).searchParams.get('job') ?? '') : wanted;

  const found = cardId
    ? store.recentJobs(500).find((j) => j.cardId === cardId)
    : store.recentJobs(500).find((j) => j.entryLevel === true && j.matched);
  const job = found && asUrl ? { ...found, applyUrl: asUrl } : found;

  if (!job) {
    console.error(
      cardId
        ? `No stored job with card id ${cardId}.`
        : 'No entry-level matched job in the database to probe.',
    );
    process.exit(1);
  }

  // --email-only: send the notification and stop. No browser is opened, the
  // portal is never contacted, and nothing is written to the applications
  // table — so the job stays eligible for a real auto-apply afterwards.
  if (process.argv.includes('--email-only')) {
    const alert = process.argv.includes('--alert');
    const notifier = ctx.buildNotifier();
    if (!notifier.configured) {
      console.error('Email is not configured; set GMAIL_USER and GMAIL_APP_PASSWORD in .env.');
      process.exit(1);
    }
    const to = applyNotifyList(process.env);
    log(`Sending the ${alert ? '"check by hand"' : '"Applied"'} email to ${to.join(', ')}`);
    log(`Subject line will be marked [test]; no application was or will be submitted.`);
    if (alert) {
      await notifier.sendApplyAlert(
        job,
        to,
        'this is a test of the alert email; nothing was submitted',
        true,
      );
    } else {
      await notifier.sendApplied(job, to, true);
    }
    log(`Sent for "${job.title.trim()}" (${job.cardId}). Nothing was applied to.`);
    store.close();
    process.exit(0);
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
