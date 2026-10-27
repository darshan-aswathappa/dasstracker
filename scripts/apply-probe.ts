/**
 * Drive the application flow for one posting.
 *
 * Default is a dry run: it signs in and fills every step exactly as the
 * unattended path would, then stops on the Review page without submitting.
 *
 *   npm run apply:probe                       # newest entry-level matched job
 *   npm run apply:probe -- 550021             # a specific card id
 *   npm run apply:probe -- <full apply url>   # one exact link
 *
 * --submit actually applies. It goes through the same pipeline as the
 * unattended scan — claim, apply, record, email — so a manual application
 * cannot behave differently from an automatic one, and a job already applied
 * to is skipped rather than applied to twice. It requires the job to be named
 * explicitly, so it can never fire at whatever happens to be newest.
 *
 *   npm run apply:probe -- 550021 --submit
 *
 * --email-only sends the notification and nothing else: no browser, no portal,
 * no database write, so the mail can be read before anything depends on it.
 *
 *   npm run apply:probe -- 550021 --email-only            # the "Applied" mail
 *   npm run apply:probe -- 550021 --email-only --alert    # the "check by hand" one
 *   npm run apply:probe -- 550021 --email-only --by-hand  # the "apply by hand" one
 *
 * The resume comes from the job's role verdict, exactly as an unattended run
 * would pick it. --resume overrides that, for probing a job Jev has not ruled
 * on yet or for checking the other document attaches cleanly.
 *
 *   npm run apply:probe -- 550021 --resume software
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/core/env.js';
import { createApp } from '../src/server/app.js';
import { createApplicator, applicatorConfigFromEnv } from '../src/core/applicator.js';
import { applyToJob } from '../src/core/autoapply.js';
import { applyNotifyList } from '../src/core/notifier.js';
import { loadApplicationProfile, resumeFor } from '../src/core/profile.js';
import type { StoredJob } from '../src/core/types.js';

const FLAGS = ['--submit', '--email-only', '--alert', '--by-hand'] as const;
const VALUED_FLAGS = ['--resume'] as const;
const RESUME_KINDS = ['ai', 'software'] as const;

type ResumeKind = (typeof RESUME_KINDS)[number];

interface Args {
  target: string | null;
  submit: boolean;
  emailOnly: boolean;
  alert: boolean;
  byHand: boolean;
  /** Which resume to attach; null means "whatever the job was classified as". */
  resume: ResumeKind | null;
}

/**
 * Parse arguments strictly.
 *
 * An unrecognised flag is an error, never ignored. A stray `--help` alongside
 * `--email-only` once sent a real email because unknown arguments were
 * silently dropped; refusing them is what stops that class of accident.
 */
export function parseArgs(argv: string[]): Args | { error: string } {
  // --resume takes a value, so its argument is consumed here rather than
  // being mistaken for the job id.
  const rest: string[] = [];
  let resume: ResumeKind | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!VALUED_FLAGS.includes(arg as (typeof VALUED_FLAGS)[number])) {
      rest.push(arg);
      continue;
    }
    const value = argv[++i];
    if (!value || !RESUME_KINDS.includes(value as ResumeKind)) {
      return { error: `--resume needs one of: ${RESUME_KINDS.join(', ')}` };
    }
    resume = value as ResumeKind;
  }

  const flags = rest.filter((a) => a.startsWith('-'));
  const unknown = flags.filter((f) => !FLAGS.includes(f as (typeof FLAGS)[number]));
  if (unknown.length > 0) {
    return { error: `unrecognised argument(s): ${unknown.join(', ')}` };
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    return { error: `expected one job id or URL, got: ${positional.join(', ')}` };
  }
  const args: Args = {
    target: positional[0] ?? null,
    submit: flags.includes('--submit'),
    emailOnly: flags.includes('--email-only'),
    alert: flags.includes('--alert'),
    byHand: flags.includes('--by-hand'),
    resume,
  };
  if (args.submit && args.emailOnly) {
    return { error: '--submit and --email-only do different things; pass only one' };
  }
  if (args.submit && !args.target) {
    return {
      error:
        '--submit needs the job named explicitly (a card id or an apply URL), so it ' +
        'cannot fire at whatever job happens to be newest',
    };
  }
  if (args.alert && !args.emailOnly) {
    return { error: '--alert only applies together with --email-only' };
  }
  if (args.byHand && !args.emailOnly) {
    return { error: '--by-hand only applies together with --email-only' };
  }
  if (args.alert && args.byHand) {
    return { error: '--alert and --by-hand are different emails; pass only one' };
  }
  return args;
}

async function main() {
  loadEnv();
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`apply-probe: ${parsed.error}`);
    process.exit(2);
  }

  const ctx = createApp();
  const { store, log } = ctx;

  // A full URL probes exactly that link; a bare id probes that stored job.
  const asUrl = parsed.target && /^https?:\/\//i.test(parsed.target) ? parsed.target : null;
  const cardId = asUrl ? (new URL(asUrl).searchParams.get('job') ?? '') : parsed.target;

  const found = cardId
    ? store.recentJobs(500).find((j) => j.cardId === cardId)
    : store.recentJobs(500).find((j) => j.entryLevel === true && j.matched);
  const job: StoredJob | undefined = found && asUrl ? { ...found, applyUrl: asUrl } : found;

  if (!job) {
    console.error(
      cardId
        ? `No stored job with card id ${cardId}.`
        : 'No entry-level matched job in the database to probe.',
    );
    process.exit(1);
  }

  // --- Notification only ---
  if (parsed.emailOnly) {
    const notifier = ctx.buildNotifier();
    if (!notifier.configured) {
      console.error('Email is not configured; set GMAIL_USER and GMAIL_APP_PASSWORD in .env.');
      process.exit(1);
    }
    const to = applyNotifyList(process.env);
    const which = parsed.alert
      ? '"check by hand"'
      : parsed.byHand
        ? '"apply by hand"'
        : '"Applied"';
    log(`Sending the ${which} email to ${to.join(', ')}`);
    log('Subject line will be marked [test]; no application was or will be submitted.');
    if (parsed.alert) {
      await notifier.sendApplyAlert(
        job,
        to,
        'this is a test of the alert email; nothing was submitted',
        true,
      );
    } else if (parsed.byHand) {
      await notifier.sendApplyByHand(
        job,
        to,
        'this is a test of the apply-by-hand email; no job was actually skipped',
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

  // An unattended run would not touch a job with no role verdict, so neither
  // does this one unless --resume says which document to send.
  const role = parsed.resume ?? job.roleKind;
  const resumeFileName = role ? resumeFor(profile, role) : null;
  if (!resumeFileName) {
    console.error(
      role === 'other'
        ? `${job.cardId} is neither an AI nor a software role, so no resume fits it. ` +
            'Pass --resume ai|software to probe it anyway.'
        : `${job.cardId} has no role verdict yet, so there is no resume to attach. ` +
            'Pass --resume ai|software to probe it anyway.',
    );
    process.exit(1);
  }

  log(`${parsed.submit ? 'APPLYING TO' : 'Probing'}: ${job.title.trim()} (${job.cardId})`);
  log(`Role: ${role}${parsed.resume ? ' (forced by --resume)' : ''}`);
  log(`Resume to attach: ${resumeFileName}`);
  log(`Apply URL: ${job.applyUrl}`);

  // --- Real application ---
  if (parsed.submit) {
    const existing = store.applicationFor(job.cardId);
    if (existing?.status === 'submitted') {
      log(`Already applied to ${job.cardId} on ${existing.submittedAt}. Nothing to do.`);
      store.close();
      process.exit(0);
    }
    log('This WILL submit the application and cannot be undone.');

    const outcome = await applyToJob(
      {
        store,
        applicator: createApplicator({ ...config, dryRun: false }, log),
        notifier: ctx.buildNotifier(),
        notifyTo: applyNotifyList(process.env),
        resumeFileName,
        log,
      },
      job,
    );

    const record = store.applicationFor(job.cardId);
    log(`Outcome: ${outcome}${record?.reason ? ` — ${record.reason}` : ''}`);
    if (record?.screenshot) log(`  last screenshot: ${record.screenshot}`);
    if (outcome === 'submitted') {
      log('Submitted and confirmed. Notification sent.');
    } else if (outcome === 'uncertain') {
      log('Submit was pressed but never confirmed — check the portal before retrying.');
    }
    store.close();
    process.exit(outcome === 'submitted' ? 0 : 1);
  }

  // --- Dry run (default) ---
  // Forced: without --submit this must never be able to submit.
  const result = await createApplicator({ ...config, dryRun: true }, log).apply(
    job,
    resumeFileName,
  );

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

/**
 * Run only when invoked as a command. Without this, importing the module to
 * test parseArgs would open the database and start an application run.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error('apply-probe failed:', err);
    process.exit(1);
  });
}
