/**
 * Applies Jev's verdicts — entry level, and what kind of role it is — to
 * stored jobs.
 *
 * Kept apart from the scan cycle so a model outage degrades one feature
 * instead of the tracker: an unclassified job keeps its blank verdict, stays
 * pending, and is picked up on the next pass.
 */

import type { Store } from './store.js';
import type { JevClassifier, EntryLevelVerdict, RoleVerdict } from './jev.js';
import type { RoleKind } from './types.js';

/** A verdict as persisted: true = entry level, false = senior, null = undecided. */
function toEntryLevel(verdict: EntryLevelVerdict): boolean | null {
  if (verdict === 'entry') return true;
  if (verdict === 'senior') return false;
  return null;
}

/**
 * Classify every job that states an experience band and has not been ruled on
 * yet. Returns how many jobs were decided. Model calls are made per distinct
 * band, so a batch of jobs sharing one band costs a single call.
 */
export async function classifyPendingJobs(
  store: Store,
  jev: JevClassifier,
  now: () => string = () => new Date().toISOString(),
  log: (msg: string) => void = () => {},
): Promise<number> {
  if (!jev.configured) return 0;

  const pending = store.jobsNeedingClassification();
  if (pending.length === 0) return 0;

  let verdicts: Map<string, EntryLevelVerdict>;
  try {
    verdicts = await jev.classifyAll(pending.map((j) => j.experience));
  } catch (err) {
    // Leave everything pending: better a missing badge than a wrong one.
    log(`Entry-level classification failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  const at = now();
  let decided = 0;
  for (const job of pending) {
    const verdict = verdicts.get(job.experience.trim());
    if (verdict === undefined) continue;
    store.setClassification(job.cardId, toEntryLevel(verdict), at);
    decided++;
  }

  if (decided > 0) {
    log(`Classified ${decided} job(s) across ${verdicts.size} distinct experience band(s).`);
  }
  return decided;
}

/** A role verdict as persisted: null for one Jev would not commit to. */
function toRoleKind(verdict: RoleVerdict): RoleKind | null {
  return verdict === 'unknown' ? null : verdict;
}

/**
 * Decide what kind of role each unclassified matched job is.
 *
 * Unlike the experience band, this question reads the posting body, so there
 * is nothing to dedupe and each job costs one call — hence the cap on how
 * many are done in a pass. A job Jev will not commit to has its attempt
 * counter raised and is retried next scan; after that the store stops
 * offering it and auto-apply mails about it instead.
 *
 * Failures are per job: one posting that trips the API must not cost the rest
 * of the batch their verdicts. A failed call counts as an attempt too — a Jev
 * outage that never ends should surface as an email asking for a human, not
 * as jobs quietly never being applied to.
 */
export async function classifyPendingRoles(
  store: Store,
  jev: JevClassifier,
  now: () => string = () => new Date().toISOString(),
  log: (msg: string) => void = () => {},
  limit = 25,
): Promise<number> {
  if (!jev.configured) return 0;

  const pending = store.jobsNeedingRoleClassification(2, limit);
  if (pending.length === 0) return 0;

  let decided = 0;
  let failed = 0;
  for (const job of pending) {
    let verdict: RoleVerdict;
    try {
      verdict = await jev.classifyRole({
        title: job.title,
        category: job.category,
        description: job.description,
      });
    } catch (err) {
      failed++;
      store.setRoleClassification(job.cardId, null, now());
      log(
        `Role classification failed for ${job.cardId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    store.setRoleClassification(job.cardId, toRoleKind(verdict), now());
    if (verdict !== 'unknown') decided++;
  }

  if (decided > 0 || failed > 0) {
    log(
      `Role classification: decided ${decided} of ${pending.length} job(s)` +
        (failed > 0 ? `, ${failed} call(s) failed` : ''),
    );
  }
  return decided;
}
