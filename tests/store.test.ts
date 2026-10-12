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
    experience: '0 to 3 years',
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
      notifyTo: [],
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

describe('Store experience + entry-level classification', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('round-trips the experience band', () => {
    store.insertJob(job('1', { experience: '4 to 5 years' }), true, 'now');
    expect(store.recentJobs()[0].experience).toBe('4 to 5 years');
  });

  it('starts every job unclassified', () => {
    store.insertJob(job('1'), true, 'now');
    const [row] = store.recentJobs();
    expect(row.entryLevel).toBeNull();
    expect(row.classifiedAt).toBeNull();
  });

  it('stores an entry-level verdict as a real boolean', () => {
    store.insertJob(job('1'), true, 'now');
    store.setClassification('1', true, '2026-10-12T00:00:00.000Z');
    const [row] = store.recentJobs();
    expect(row.entryLevel).toBe(true);
    expect(row.classifiedAt).toBe('2026-10-12T00:00:00.000Z');
  });

  it('stores a senior verdict distinctly from an undecided one', () => {
    store.insertJob(job('1'), true, 'now');
    store.insertJob(job('2'), true, 'now');
    store.setClassification('1', false, 'ts');
    store.setClassification('2', null, 'ts');
    const byId = new Map(store.recentJobs().map((j) => [j.cardId, j]));
    expect(byId.get('1')?.entryLevel).toBe(false);
    expect(byId.get('2')?.entryLevel).toBeNull();
    // Both were asked about, so neither comes back as pending.
    expect(byId.get('2')?.classifiedAt).toBe('ts');
  });

  it('lists only jobs that have a band and have never been classified', () => {
    store.insertJob(job('1', { experience: '0 to 3 years' }), true, 'now');
    store.insertJob(job('2', { experience: '' }), true, 'now'); // nothing to classify
    store.insertJob(job('3', { experience: '4 to 5 years' }), true, 'now');
    store.setClassification('3', false, 'ts'); // already decided
    expect(store.jobsNeedingClassification().map((j) => j.cardId)).toEqual(['1']);
  });

  it('respects the limit when listing pending jobs', () => {
    for (let i = 0; i < 5; i++) store.insertJob(job(String(i)), true, 'now');
    expect(store.jobsNeedingClassification(2)).toHaveLength(2);
  });

  it('backfills an experience band onto an existing row', () => {
    store.insertJob(job('1', { experience: '' }), true, 'now');
    expect(store.jobsNeedingClassification()).toHaveLength(0);
    store.setExperience('1', '6 to 7 years');
    expect(store.recentJobs()[0].experience).toBe('6 to 7 years');
    // Having a band now makes it eligible for classification.
    expect(store.jobsNeedingClassification().map((j) => j.cardId)).toEqual(['1']);
  });

  it('lists jobs still missing a band, for the backfill to look up', () => {
    store.insertJob(job('1', { experience: '0 to 3 years' }), true, 'now');
    store.insertJob(job('2', { experience: '' }), true, 'now');
    expect(store.jobsMissingExperience().map((j) => j.cardId)).toEqual(['2']);
  });
});
