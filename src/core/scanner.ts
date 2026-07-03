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
import type { WhatsAppNotifier } from './whatsapp.js';
import type { ScanResult, TrackerConfig } from './types.js';

export interface ScanDeps {
  store: Store;
  notifier: Notifier;
  /** Optional WhatsApp channel; digests fan out to it alongside email. */
  whatsapp?: WhatsAppNotifier;
  config: TrackerConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Run a single scan cycle and return its result (also persisted). */
export async function runScan(deps: ScanDeps): Promise<ScanResult> {
  const { store, notifier, whatsapp, config } = deps;
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
