import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/core/store.js';
import type { Job } from '../src/core/types.js';

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    cardId: id,
    title: `Job ${id}`,
    url: `https://x/${id}`,
    applyUrl: `https://apply/${id}`,
    location: 'US, TX, Plano',
    category: 'Research & Development',
    products: 'SIMULIA',
    postedAt: '2026-07-02T03:00:00.000Z',
    ...overrides,
  };
}

describe('Store', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('inserts a job and reports it as known', () => {
    expect(store.insertJob(job('1'), true, 'now')).toBe(true);
    expect(store.hasJob('1')).toBe(true);
    expect(store.countJobs()).toBe(1);
  });

  it('dedups: second insert of same card_id is a no-op', () => {
    expect(store.insertJob(job('1'), true, 'now')).toBe(true);
    expect(store.insertJob(job('1'), true, 'later')).toBe(false);
    expect(store.countJobs()).toBe(1);
  });

  it('knownIds returns only ids already stored', () => {
    store.insertJob(job('1'), true, 'now');
    store.insertJob(job('2'), false, 'now');
    const known = store.knownIds(['1', '2', '3']);
    expect([...known].sort()).toEqual(['1', '2']);
  });

  it('unnotifiedMatched excludes unmatched and already-notified jobs', () => {
    store.insertJob(job('1'), true, 'now'); // matched, unnotified
    store.insertJob(job('2'), false, 'now'); // unmatched
    store.insertJob(job('3'), true, 'now'); // matched, will be notified
    store.markNotified(['3'], 'now');

    const pending = store.unnotifiedMatched();
    expect(pending.map((j) => j.cardId)).toEqual(['1']);
  });

  it('markNotified prevents re-notification (no duplicates)', () => {
    store.insertJob(job('1'), true, 'now');
    expect(store.unnotifiedMatched()).toHaveLength(1);
    store.markNotified(['1'], 'ts');
    expect(store.unnotifiedMatched()).toHaveLength(0);
    const stored = store.recentJobs(10, true)[0];
    expect(stored.notifiedAt).toBe('ts');
  });

  it('persists and reloads config merged over defaults', () => {
    const defaults = {
      intervalMinutes: 10,
      country: 'United States',
      type: 'Regular',
      lang: 'en',
      keywords: ['a'],
      categoryWhitelist: [],
      notifyTo: null,
    };
    expect(store.loadConfig(defaults)).toEqual(defaults);
    store.saveConfig({ ...defaults, intervalMinutes: 5, keywords: ['b', 'c'] });
    const loaded = store.loadConfig(defaults);
    expect(loaded.intervalMinutes).toBe(5);
    expect(loaded.keywords).toEqual(['b', 'c']);
  });

  it('records and reads back scans', () => {
    store.recordScan({
      startedAt: 't',
      fetched: 5,
      newCount: 2,
      matchedCount: 1,
      notifiedCount: 1,
      error: null,
    });
    const last = store.lastScan();
    expect(last?.fetched).toBe(5);
    expect(last?.matchedCount).toBe(1);
  });
});
