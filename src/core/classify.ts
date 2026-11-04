/**
 * Applies Jev's entry-level verdicts to stored jobs.
 *
 * Kept apart from the scan cycle so a model outage degrades one feature
 * instead of the tracker: an unclassified job keeps its blank verdict, stays
 * pending, and is picked up on the next pass.
 */

import type { Store } from './store.js';
import type { JevClassifier, EntryLevelVerdict } from './jev.js';

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
