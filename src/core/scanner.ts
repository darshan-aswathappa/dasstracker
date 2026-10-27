/**
 * Orchestrates one scan cycle: fetch newest jobs, store unseen ones, match
 * them, and email a digest of newly matched jobs.
 *
 * First run seeds the DB as a baseline WITHOUT sending email (avoids blasting a
 * notification for every currently-open job). Only jobs discovered after the
 * baseline can trigger an email. Notification is idempotent via notified_at, so
 * duplicates never occur even if a send is retried.
 */

import { fetchJobs, type FetchQuery } from './fetcher.js';
import { matchJob } from './matcher.js';
import type { Store } from './store.js';
import { classifyPendingJobs, classifyPendingRoles } from './classify.js';
import { armedAt, runAutoApply, type AutoApplySummary } from './autoapply.js';
import type { Applicator } from './applicator.js';
import type { ApplicationProfile } from './profile.js';
import type { JevClassifier } from './jev.js';
import type { Notifier } from './notifier.js';
import type { WhatsAppNotifier } from './whatsapp.js';
import type { ScanResult, TrackerConfig } from './types.js';

export interface ScanDeps {
  store: Store;
  notifier: Notifier;
  /** Optional WhatsApp channel; digests fan out to it alongside email. */
  whatsapp?: WhatsAppNotifier;
  /** Optional entry-level classifier; when absent, jobs stay unclassified. */
  jev?: JevClassifier;
  /** Optional auto-apply stage; only acts when explicitly armed. */
  autoApply?: {
    applicator: Applicator;
    /** Names the resume each kind of role gets. */
    profile: ApplicationProfile;
    enabled: boolean;
    maxPerRun: number;
    notifyTo: string[];
  };
  config: TrackerConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Run a single scan cycle and return its result (also persisted). */
export async function runScan(deps: ScanDeps): Promise<ScanResult> {
  const { store, notifier, whatsapp, jev, autoApply, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const startedAt = now().toISOString();

  const result: ScanResult = {
    startedAt,
    fetched: 0,
    newCount: 0,
    matchedCount: 0,
    notifiedCount: 0,
    error: null,
  };

  try {
    const isBaseline = store.countJobs() === 0;

    // Establish the arming mark BEFORE any job is stored. Written later, it
    // would be newer than the first_seen_at of everything found in this very
    // scan, and since first_seen_at never changes those jobs would be skipped
    // for good rather than just this once.
    if (autoApply?.enabled && !isBaseline) {
      armedAt(store, now());
    }
    const query: FetchQuery = {
      lang: config.lang,
      type: config.type,
      country: config.country,
    };

    const jobs = await fetchJobs(query, {
      pageSize: 50,
      maxPages: 3,
      fetchImpl: deps.fetchImpl,
      // Stop paging once an entire page is already known.
      stopWhen: (pageJobs) => {
        const known = store.knownIds(pageJobs.map((j) => j.cardId));
        return pageJobs.length > 0 && pageJobs.every((j) => known.has(j.cardId));
      },
    });
    result.fetched = jobs.length;

    const seenAt = now().toISOString();
    let newMatched = 0;
    for (const job of jobs) {
      const { matched } = matchJob(job, config.keywords, config.categoryWhitelist);
      const inserted = store.insertJob(job, matched, seenAt);
      if (inserted) {
        result.newCount++;
        if (matched) newMatched++;
      }
    }
    result.matchedCount = newMatched;

    // Badge the new arrivals before any digest goes out. Best-effort by
    // design: a Jev outage leaves jobs unbadged but must not stall a scan.
    if (jev) {
      await classifyPendingJobs(store, jev, () => now().toISOString(), log);
      // And decide what kind of role each one is, which is what names the
      // resume an application carries. Runs before auto-apply for that
      // reason: a job with no verdict yet simply waits for the next scan.
      await classifyPendingRoles(store, jev, () => now().toISOString(), log);
    }

    // Apply before the digest so a submitted job is already on record by the
    // time its notification goes out. Never on the baseline seed: that pass
    // exists to establish what already-open jobs look like, not to act on them.
    if (autoApply && !isBaseline) {
      await runAutoApplyStage(deps, autoApply, now, log);
    }

    if (isBaseline) {
      // Baseline seed: mark all matched jobs as already-notified so they never
      // fire retroactive emails. Only future discoveries notify.
      const pending = store.unnotifiedMatched();
      store.markNotified(
        pending.map((j) => j.cardId),
        seenAt,
      );
      log(
        `Baseline scan: seeded ${result.newCount} jobs (${pending.length} matched), no email sent.`,
      );
    } else {
      const anyConfigured = notifier.configured || (whatsapp?.configured ?? false);
      const pending = anyConfigured ? store.unnotifiedMatched() : [];
      if (pending.length > 0) {
        // Best-effort per channel: a failure in one (e.g. SMTP blocked) must
        // not prevent the other from delivering, and we only mark the jobs as
        // notified once at least one channel succeeded (so failures retry).
        let delivered = false;
        if (notifier.configured) {
          try {
            await notifier.send(pending);
            delivered = true;
            log(`Sent email digest for ${pending.length} new matching job(s).`);
          } catch (err) {
            log(`Email digest failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (whatsapp?.configured) {
          try {
            await whatsapp.send(pending);
            delivered = true;
            log(`Sent WhatsApp digest for ${pending.length} new matching job(s).`);
          } catch (err) {
            log(`WhatsApp digest failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (delivered) {
          store.markNotified(
            pending.map((j) => j.cardId),
            now().toISOString(),
          );
          result.notifiedCount = pending.length;
        }
      } else if (newMatched > 0 && !anyConfigured) {
        log(`${newMatched} new matching job(s) found but no notifier is configured.`);
      }
    }

    log(
      `Scan complete: fetched=${result.fetched} new=${result.newCount} ` +
        `matched=${result.matchedCount} notified=${result.notifiedCount}`,
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log(`Scan error: ${result.error}`);
  }

  store.recordScan(result);
  return result;
}


/**
 * Run the auto-apply stage without letting it break a scan. An applicator
 * fault must cost at most this feature: the scan still stores jobs and sends
 * its digest.
 */
async function runAutoApplyStage(
  deps: ScanDeps,
  autoApply: NonNullable<ScanDeps['autoApply']>,
  now: () => Date,
  log: (msg: string) => void,
): Promise<AutoApplySummary | null> {
  try {
    return await runAutoApply({
      store: deps.store,
      applicator: autoApply.applicator,
      profile: autoApply.profile,
      notifier: deps.notifier,
      notifyTo: autoApply.notifyTo,
      enabled: autoApply.enabled,
      maxPerRun: autoApply.maxPerRun,
      now,
      log,
    });
  } catch (err) {
    log(`Auto-apply stage failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
