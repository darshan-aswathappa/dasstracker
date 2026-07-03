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
import type { Notifier } from './notifier.js';
import type { ScanResult, TrackerConfig } from './types.js';

export interface ScanDeps {
  store: Store;
  notifier: Notifier;
  config: TrackerConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Run a single scan cycle and return its result (also persisted). */
export async function runScan(deps: ScanDeps): Promise<ScanResult> {
  const { store, notifier, config } = deps;
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
    } else if (notifier.configured) {
      const pending = store.unnotifiedMatched();
      if (pending.length > 0) {
        await notifier.send(pending);
        store.markNotified(
          pending.map((j) => j.cardId),
          now().toISOString(),
        );
        result.notifiedCount = pending.length;
        log(`Sent digest for ${pending.length} new matching job(s).`);
      }
    } else if (newMatched > 0) {
      log(`${newMatched} new matching job(s) found but email is not configured.`);
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
