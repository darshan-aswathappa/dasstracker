import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { runScan } from '../src/core/scanner.js';
import type { Notifier } from '../src/core/notifier.js';
import type { TrackerConfig, StoredJob } from '../src/core/types.js';

const config: TrackerConfig = {
  intervalMinutes: 10,
  country: 'United States',
  type: 'Regular',
  lang: 'en',
  keywords: ['engineer', 'software'],
  categoryWhitelist: ['Information Technology'],
  notifyTo: null,
};

/** Build a fake API page response from a list of (id, title) tuples. */
function apiPage(jobs: Array<{ id: string; title: string; category?: string }>) {
  return {
    hits: jobs.map((j) => ({
      metas: [
        { name: 'card_id', value: j.id },
        { name: 'content_title', value: j.title },
        { name: 'content_cta_1_url', value: `https://www.3ds.com/jobs/${j.id}` },
        { name: 'content_cta_2_url', value: `https://apply/${j.id}` },
        { name: 'content_info_2_value', value: 'United States, TX, Plano' },
        {
          name: 'content_categories',
          value: `Category/${j.category ?? 'Sales'} Type/Regular Country/United States`,
        },
        { name: 'content_start_datetime', value: '2026/07/02 03:07:05' },
      ],
    })),
  };
}

function fetchReturning(page: unknown): typeof fetch {
  return (async () => ({ ok: true, json: async () => page }) as Response) as unknown as typeof fetch;
}

function mockNotifier(): Notifier & { sent: StoredJob[][] } {
  const sent: StoredJob[][] = [];
  return {
    configured: true,
    sent,
    async verify() {},
    async send(jobs: StoredJob[]) {
      sent.push(jobs);
    },
  };
}

describe('runScan', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('baseline scan seeds without sending email', async () => {
    const notifier = mockNotifier();
    const page = apiPage([
      { id: '1', title: 'Software Engineer' },
      { id: '2', title: 'Account Executive' },
    ]);
    const res = await runScan({
      store,
      notifier,
      config,
      fetchImpl: fetchReturning(page),
    });
    expect(res.newCount).toBe(2);
    expect(res.matchedCount).toBe(1);
    expect(res.notifiedCount).toBe(0);
    expect(notifier.sent).toHaveLength(0);
    // The matched baseline job is marked notified so it never fires later.
    expect(store.unnotifiedMatched()).toHaveLength(0);
  });

  it('notifies only for jobs appearing after baseline', async () => {
    const notifier = mockNotifier();
    // Baseline
    await runScan({
      store,
      notifier,
      config,
      fetchImpl: fetchReturning(apiPage([{ id: '1', title: 'Software Engineer' }])),
    });
    // Second scan: a new matching job + the old one
    const res = await runScan({
      store,
      notifier,
      config,
      fetchImpl: fetchReturning(
        apiPage([
          { id: '2', title: 'AI Engineer' },
          { id: '1', title: 'Software Engineer' },
        ]),
      ),
    });
    expect(res.newCount).toBe(1);
    expect(res.notifiedCount).toBe(1);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].map((j) => j.cardId)).toEqual(['2']);
  });

  it('does not re-notify on a subsequent scan (dedup)', async () => {
    const notifier = mockNotifier();
    await runScan({
      store,
      notifier,
      config,
      fetchImpl: fetchReturning(apiPage([{ id: '1', title: 'Sales Rep' }])),
    });
    await runScan({
      store,
      notifier,
      config,
      fetchImpl: fetchReturning(apiPage([{ id: '2', title: 'DevOps Engineer' }])),
    });
    // Same data again — nothing new.
    const res = await runScan({
      store,
      notifier,
      config,
      fetchImpl: fetchReturning(apiPage([{ id: '2', title: 'DevOps Engineer' }])),
    });
    expect(res.newCount).toBe(0);
    expect(res.notifiedCount).toBe(0);
    expect(notifier.sent).toHaveLength(1); // only the one from job 2's first appearance
  });

  it('records an error without throwing when fetch fails', async () => {
    const notifier = mockNotifier();
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await runScan({ store, notifier, config, fetchImpl: failing });
    expect(res.error).toContain('network down');
    expect(store.lastScan()?.error).toContain('network down');
  });

  it('matches via category whitelist', async () => {
    const notifier = mockNotifier();
    // Baseline empty-ish then new IT job
    await runScan({
      store,
      notifier,
      config,
      fetchImpl: fetchReturning(apiPage([{ id: '1', title: 'Sales Rep' }])),
    });
    const res = await runScan({
      store,
      notifier,
      config,
      fetchImpl: fetchReturning(
        apiPage([{ id: '9', title: 'Accountant', category: 'Information Technology' }]),
      ),
    });
    expect(res.matchedCount).toBe(1);
    expect(notifier.sent[0].map((j) => j.cardId)).toEqual(['9']);
  });
});
