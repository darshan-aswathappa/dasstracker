/**
 * Decides which newly classified jobs get an application, and runs them.
 *
 * Three guards stand between a scan and an irreversible submission:
 *   - the feature is off unless AUTO_APPLY_ENABLED is explicitly set;
 *   - only jobs first seen after the feature was armed are eligible, so
 *     switching it on never fires at the existing backlog;
 *   - a per-run cap bounds the damage if classification ever goes wrong.
 *
 * Applications run one at a time. A failure is recorded and retried on a later
 * scan up to the attempt cap; a success is recorded once and never repeated.
 */

import type { Store } from './store.js';
import type { Applicator } from './applicator.js';
import type { Notifier } from './notifier.js';
import type { StoredJob } from './types.js';

/** Settings key holding the moment auto-apply was first armed. */
export const ARMED_AT_KEY = 'autoApplyArmedAt';

export interface AutoApplyDeps {
  store: Store;
  applicator: Applicator;
  notifier: Notifier;
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

/** Apply to everything eligible, up to the per-run cap. */
export async function runAutoApply(deps: AutoApplyDeps): Promise<AutoApplySummary> {
  const { store, applicator, notifier, notifyTo, enabled, maxPerRun } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const summary: AutoApplySummary = { attempted: 0, submitted: 0, failed: 0, dryRun: 0 };

  if (!enabled) return summary;
  if (!applicator.configured) {
    log('Auto-apply is on but no portal credentials are set — nothing attempted.');
    return summary;
  }

  const since = armedAt(store, now());
  const pending = store.jobsToAutoApply(since, deps.maxAttempts ?? 3, maxPerRun);
  if (pending.length === 0) return summary;

  log(`Auto-apply: ${pending.length} entry-level job(s) to apply to.`);

  for (const job of pending) {
    // Re-check immediately before acting: a concurrent run may have taken it.
    if (store.hasApplied(job.cardId)) continue;

    summary.attempted++;
    const attemptedAt = now().toISOString();
    const result = await applicator.apply(job);
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
      summary.submitted++;
      await sendConfirmation(notifier, job, notifyTo, log);
    } else if (result.outcome === 'dry_run') {
      summary.dryRun++;
    } else {
      summary.failed++;
    }
  }

  log(
    `Auto-apply done: attempted=${summary.attempted} submitted=${summary.submitted} ` +
      `failed=${summary.failed} dryRun=${summary.dryRun}`,
  );
  return summary;
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
