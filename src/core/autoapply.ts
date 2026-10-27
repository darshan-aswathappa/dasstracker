/**
 * Decides which newly classified jobs get an application, and runs them.
 *
 * Four guards stand between a scan and an irreversible submission:
 *   - the feature is off unless AUTO_APPLY_ENABLED is explicitly set;
 *   - only jobs first seen after the feature was armed are eligible, so
 *     switching it on never fires at the existing backlog;
 *   - a per-run cap bounds the damage if classification ever goes wrong;
 *   - a job is only applied to once Jev has said whether it is an AI or a
 *     software role, which is what names the resume. Anything else — a role
 *     that is neither, or one Jev would not commit to — is mailed to the
 *     candidate to do by hand rather than applied to with a guessed resume.
 *
 * Applications run one at a time. A failure is recorded and retried on a later
 * scan up to the attempt cap; a success is recorded once and never repeated.
 */

import type { Store } from './store.js';
import type { Applicator } from './applicator.js';
import type { Notifier } from './notifier.js';
import { resumeFor, type ApplicationProfile } from './profile.js';
import type { StoredJob } from './types.js';

/** Settings key holding the moment auto-apply was first armed. */
export const ARMED_AT_KEY = 'autoApplyArmedAt';

export interface AutoApplyDeps {
  store: Store;
  applicator: Applicator;
  notifier: Notifier;
  /** Names the resume each kind of role gets. */
  profile: ApplicationProfile;
  /** Who to tell when an application goes through. */
  notifyTo: string[];
  enabled: boolean;
  maxPerRun: number;
  maxAttempts?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface AutoApplySummary {
  attempted: number;
  submitted: number;
  failed: number;
  dryRun: number;
  /** Submitted but unconfirmed — needs a human to check the portal. */
  uncertain: number;
  /** Left alone and mailed about: no resume could be chosen for them. */
  handedOver: number;
}

/**
 * Return the arming timestamp, setting it on the first armed run.
 *
 * Recording it at arming time is what keeps the backlog out: jobs already in
 * the database when the switch was flipped are older than this mark.
 */
export function armedAt(store: Store, now: Date): string {
  const existing = store.getSetting(ARMED_AT_KEY);
  if (existing) return existing;
  const stamp = now.toISOString();
  store.setSetting(ARMED_AT_KEY, stamp);
  return stamp;
}

/** What one application attempt came to. `skipped` means it was not claimed. */
export type ApplyOneOutcome = 'skipped' | 'submitted' | 'failed' | 'dry_run' | 'uncertain';

export interface ApplyOneDeps {
  store: Store;
  applicator: Applicator;
  notifier: Notifier;
  notifyTo: string[];
  /** The resume to attach, already chosen for this job. */
  resumeFileName: string;
  maxAttempts?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

/**
 * Apply to one job: claim it, run the flow, record the outcome, notify.
 *
 * The single place an application is made. Both the unattended scan and the
 * one-shot command go through here, so a manual run cannot behave differently
 * from the automatic one — including the claim that stops a job being applied
 * to twice.
 */
export async function applyToJob(deps: ApplyOneDeps, job: StoredJob): Promise<ApplyOneOutcome> {
  const { store, applicator, notifier, notifyTo } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});

  const attemptedAt = now().toISOString();
  if (!store.claimForApplication(job.cardId, attemptedAt, deps.maxAttempts ?? 3)) {
    const existing = store.applicationFor(job.cardId);
    log(
      `Auto-apply: ${job.cardId} is already claimed or not retryable ` +
        `(status ${existing?.status ?? 'unknown'}); skipping.`,
    );
    return 'skipped';
  }

  const result = await applicator.apply(job, deps.resumeFileName);
  const screenshot = result.screenshots.at(-1) ?? null;

  store.recordApplication({
    cardId: job.cardId,
    status: result.outcome,
    attemptedAt,
    submittedAt: result.outcome === 'submitted' ? now().toISOString() : null,
    reason: result.reason,
    screenshot,
  });

  if (result.outcome === 'submitted') {
    await sendConfirmation(notifier, job, notifyTo, log);
  } else if (result.outcome === 'uncertain') {
    // Nobody is watching the logs on an unattended run, so this one gets
    // mailed: it is the case where a duplicate application is possible.
    await sendAlert(notifier, job, notifyTo, result.reason ?? 'unknown', log);
  }

  return result.outcome;
}

/** Apply to everything eligible, up to the per-run cap. */
export async function runAutoApply(deps: AutoApplyDeps): Promise<AutoApplySummary> {
  const { store, applicator, notifier, notifyTo, profile, enabled, maxPerRun } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const summary: AutoApplySummary = {
    attempted: 0,
    submitted: 0,
    failed: 0,
    dryRun: 0,
    uncertain: 0,
    handedOver: 0,
  };

  if (!enabled) return summary;
  if (!applicator.configured) {
    log('Auto-apply is on but no portal credentials are set — nothing attempted.');
    return summary;
  }

  const since = armedAt(store, now());

  // Hand over what the bot will not apply to first: those jobs need nothing
  // from the browser, and doing them before the slow part means an
  // applicator fault cannot swallow the email that explains the skip.
  summary.handedOver = await handOverUnclassified(deps, since, now, log);

  const pending = store.jobsToAutoApply(since, deps.maxAttempts ?? 3, maxPerRun);
  if (pending.length === 0) return summary;

  log(`Auto-apply: ${pending.length} entry-level job(s) to apply to.`);

  for (const job of pending) {
    // The store only offers jobs with a role verdict, so this always names a
    // resume; the guard is here because an unnamed one must never be guessed.
    const resumeFileName = job.roleKind ? resumeFor(profile, job.roleKind) : null;
    if (!resumeFileName) {
      log(`Auto-apply: ${job.cardId} has no resume for role "${job.roleKind}"; skipping.`);
      continue;
    }

    log(`Auto-apply: ${job.cardId} is a ${job.roleKind} role — attaching ${resumeFileName}.`);
    const outcome = await applyToJob(
      {
        store,
        applicator,
        notifier,
        notifyTo,
        resumeFileName,
        maxAttempts: deps.maxAttempts,
        now,
        log,
      },
      job,
    );
    if (outcome === 'skipped') continue;

    summary.attempted++;
    if (outcome === 'submitted') summary.submitted++;
    else if (outcome === 'dry_run') summary.dryRun++;
    else if (outcome === 'uncertain') summary.uncertain++;
    else summary.failed++;
  }

  log(
    `Auto-apply done: attempted=${summary.attempted} submitted=${summary.submitted} ` +
      `failed=${summary.failed} dryRun=${summary.dryRun} uncertain=${summary.uncertain} ` +
      `handedOver=${summary.handedOver}`,
  );
  return summary;
}

/** Why a job was handed to a human rather than applied to. */
function handoverReason(job: StoredJob): string {
  return job.roleKind === 'other'
    ? 'This is neither an AI nor a software engineering role, so neither resume on ' +
        'the account is the right one to send.'
    : 'The role could not be classified as AI or software engineering even after a ' +
        'retry, so there was no way to tell which resume to attach.';
}

/**
 * Mail the candidate about every eligible job the bot will not apply to, and
 * record that it did so.
 *
 * The mark is written only after the mail goes out, so a send that fails is
 * retried on the next scan rather than lost. Each job is independent: one
 * failed send must not stop the others.
 */
async function handOverUnclassified(
  deps: AutoApplyDeps,
  since: string,
  now: () => Date,
  log: (msg: string) => void,
): Promise<number> {
  const { store, notifier, notifyTo } = deps;
  const jobs = store.jobsNeedingManualApply(since, 2, deps.maxPerRun);
  if (jobs.length === 0) return 0;

  if (!notifier.configured) {
    log(
      `${jobs.length} job(s) need applying to by hand, but email is not configured ` +
        'to say so.',
    );
    return 0;
  }

  let sent = 0;
  for (const job of jobs) {
    try {
      await notifier.sendApplyByHand(job, notifyTo, handoverReason(job));
      store.markRoleAlerted(job.cardId, now().toISOString());
      sent++;
      log(`Handed "${job.title.trim()}" (${job.cardId}) over to be applied to by hand.`);
    } catch (err) {
      log(
        `Could not mail the apply-by-hand notice for ${job.cardId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return sent;
}

/** Tell the recipients an application needs checking by hand. */
async function sendAlert(
  notifier: Notifier,
  job: StoredJob,
  to: string[],
  reason: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!notifier.configured) return;
  try {
    await notifier.sendApplyAlert(job, to, reason);
  } catch (err) {
    log(`Could not send the needs-checking alert: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Send the confirmation, best-effort. The application is already submitted by
 * this point, so a mail failure must not mark it as failed and trigger a retry
 * that would apply a second time.
 */
async function sendConfirmation(
  notifier: Notifier,
  job: StoredJob,
  to: string[],
  log: (msg: string) => void,
): Promise<void> {
  if (!notifier.configured) {
    log(`Applied to "${job.title.trim()}" but email is not configured to confirm it.`);
    return;
  }
  try {
    await notifier.sendApplied(job, to);
    log(`Confirmation sent to ${to.join(', ')} for "${job.title.trim()}".`);
  } catch (err) {
    log(
      `Applied to "${job.title.trim()}" but the confirmation email failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
