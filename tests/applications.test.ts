import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/core/store.js';
import type { Job } from '../src/core/types.js';

function job(id: string, seenAt: string): Job {
  return {
    cardId: id,
    title: `Job ${id}`,
    url: `https://x/${id}`,
    applyUrl: `https://apply/${id}`,
    location: 'US',
    category: 'Research & Development',
    products: '',
    experience: '0 to 3 years',
    postedAt: seenAt,
  };
}

const ARMED = '2026-10-12T00:00:00.000Z';

describe('auto-apply eligibility', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => store.close());

  /** Insert a job and give it an entry-level verdict. */
  function entryLevel(id: string, seenAt: string, matched = true) {
    store.insertJob(job(id, seenAt), matched, seenAt);
    store.setClassification(id, true, seenAt);
  }

  it('offers an entry-level matched job seen after arming', () => {
    entryLevel('1', '2026-10-12T10:00:00.000Z');
    expect(store.jobsToAutoApply(ARMED).map((j) => j.cardId)).toEqual(['1']);
  });

  it('ignores the backlog seen before auto-apply was armed', () => {
    entryLevel('old', '2026-10-01T00:00:00.000Z');
    entryLevel('new', '2026-10-12T10:00:00.000Z');
    expect(store.jobsToAutoApply(ARMED).map((j) => j.cardId)).toEqual(['new']);
  });

  it('ignores jobs that are not entry level', () => {
    store.insertJob(job('senior', '2026-10-12T10:00:00.000Z'), true, '2026-10-12T10:00:00.000Z');
    store.setClassification('senior', false, ARMED);
    expect(store.jobsToAutoApply(ARMED)).toHaveLength(0);
  });

  it('offers entry-level jobs regardless of the keyword filter', () => {
    // The keyword/category rule gates the email digest, not applying. Entry
    // level is the whole criterion, so a Legal or Sales posting counts too.
    entryLevel('unmatched', '2026-10-12T10:00:00.000Z', false);
    expect(store.jobsToAutoApply(ARMED).map((j) => j.cardId)).toEqual(['unmatched']);
  });

  it('offers matched and unmatched entry-level jobs alike', () => {
    entryLevel('keyworded', '2026-10-12T10:00:00.000Z', true);
    entryLevel('not-keyworded', '2026-10-12T11:00:00.000Z', false);
    expect(store.jobsToAutoApply(ARMED).map((j) => j.cardId).sort()).toEqual([
      'keyworded',
      'not-keyworded',
    ]);
  });

  it('still ignores a job that is not entry level, matched or not', () => {
    store.insertJob(job('senior-matched', '2026-10-12T10:00:00.000Z'), true, '2026-10-12T10:00:00.000Z');
    store.setClassification('senior-matched', false, ARMED);
    store.insertJob(job('senior-unmatched', '2026-10-12T10:00:00.000Z'), false, '2026-10-12T10:00:00.000Z');
    store.setClassification('senior-unmatched', false, ARMED);
    expect(store.jobsToAutoApply(ARMED)).toHaveLength(0);
  });

  it('ignores jobs still awaiting a verdict', () => {
    store.insertJob(job('pending', '2026-10-12T10:00:00.000Z'), true, '2026-10-12T10:00:00.000Z');
    expect(store.jobsToAutoApply(ARMED)).toHaveLength(0);
  });

  it('never offers a job twice once submitted', () => {
    entryLevel('1', '2026-10-12T10:00:00.000Z');
    store.recordApplication({
      cardId: '1',
      status: 'submitted',
      attemptedAt: 'ts',
      submittedAt: 'ts',
      reason: null,
      screenshot: null,
    });
    expect(store.jobsToAutoApply(ARMED)).toHaveLength(0);
    expect(store.hasApplied('1')).toBe(true);
  });

  it('retries a failure until the attempt cap, then stops', () => {
    entryLevel('1', '2026-10-12T10:00:00.000Z');
    const fail = () =>
      store.recordApplication({
        cardId: '1',
        status: 'failed',
        attemptedAt: 'ts',
        submittedAt: null,
        reason: 'timeout',
        screenshot: null,
      });

    fail(); // attempts = 1
    expect(store.jobsToAutoApply(ARMED, 3)).toHaveLength(1);
    fail(); // attempts = 2
    expect(store.jobsToAutoApply(ARMED, 3)).toHaveLength(1);
    fail(); // attempts = 3 — cap reached
    expect(store.jobsToAutoApply(ARMED, 3)).toHaveLength(0);
    expect(store.applicationFor('1')?.attempts).toBe(3);
  });

  it('does not retry a dry run as if it had failed', () => {
    entryLevel('1', '2026-10-12T10:00:00.000Z');
    store.recordApplication({
      cardId: '1',
      status: 'dry_run',
      attemptedAt: 'ts',
      submittedAt: null,
      reason: 'stopped before submit',
      screenshot: '/tmp/x.png',
    });
    expect(store.jobsToAutoApply(ARMED)).toHaveLength(0);
    expect(store.hasApplied('1')).toBe(false);
  });

  it('respects the per-run limit', () => {
    for (let i = 0; i < 5; i++) entryLevel(String(i), '2026-10-12T10:00:00.000Z');
    expect(store.jobsToAutoApply(ARMED, 3, 2)).toHaveLength(2);
  });

  it('counts applications by status', () => {
    entryLevel('1', '2026-10-12T10:00:00.000Z');
    store.recordApplication({
      cardId: '1',
      status: 'submitted',
      attemptedAt: 'ts',
      submittedAt: 'ts',
      reason: null,
      screenshot: null,
    });
    expect(store.countApplications('submitted')).toBe(1);
    expect(store.countApplications('failed')).toBe(0);
  });
});
