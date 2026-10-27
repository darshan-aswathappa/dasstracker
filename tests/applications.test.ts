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
    description: 'Write software.',
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

  /**
   * Insert a job and give it both verdicts it needs to be applied to: entry
   * level, and a role that names a resume.
   */
  function entryLevel(id: string, seenAt: string, matched = true) {
    store.insertJob(job(id, seenAt), matched, seenAt);
    store.setClassification(id, true, seenAt);
    store.setRoleClassification(id, 'ai', seenAt);
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

  it('ignores entry-level jobs that did not match the keyword filter', () => {
    entryLevel('unmatched', '2026-10-12T10:00:00.000Z', false);
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

  it('ignores a job whose role has not been decided yet', () => {
    store.insertJob(job('norole', '2026-10-12T10:00:00.000Z'), true, '2026-10-12T10:00:00.000Z');
    store.setClassification('norole', true, ARMED);
    expect(store.jobsToAutoApply(ARMED)).toHaveLength(0);
  });

  it('ignores a job that is neither an AI nor a software role', () => {
    store.insertJob(job('sales', '2026-10-12T10:00:00.000Z'), true, '2026-10-12T10:00:00.000Z');
    store.setClassification('sales', true, ARMED);
    store.setRoleClassification('sales', 'other', ARMED);
    expect(store.jobsToAutoApply(ARMED)).toHaveLength(0);
  });

  it('offers a software role alongside an AI one', () => {
    entryLevel('ai', '2026-10-12T10:00:00.000Z');
    store.insertJob(job('swe', '2026-10-12T11:00:00.000Z'), true, '2026-10-12T11:00:00.000Z');
    store.setClassification('swe', true, ARMED);
    store.setRoleClassification('swe', 'software', ARMED);
    expect(store.jobsToAutoApply(ARMED).map((j) => j.cardId).sort()).toEqual(['ai', 'swe']);
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

describe('jobs that need applying to by hand', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => store.close());

  /** An entry-level matched job seen after arming, with no role verdict yet. */
  function unclassified(id: string, attempts = 0) {
    const seenAt = '2026-10-12T10:00:00.000Z';
    store.insertJob(job(id, seenAt), true, seenAt);
    store.setClassification(id, true, seenAt);
    for (let i = 0; i < attempts; i++) store.setRoleClassification(id, null, seenAt);
  }

  it('lists a job Jev ruled is neither kind of engineering', () => {
    unclassified('sales');
    store.setRoleClassification('sales', 'other', ARMED);
    expect(store.jobsNeedingManualApply(ARMED).map((j) => j.cardId)).toEqual(['sales']);
  });

  it('leaves an undecided job alone until the retry is spent', () => {
    unclassified('maybe', 1);
    expect(store.jobsNeedingManualApply(ARMED)).toHaveLength(0);
    store.setRoleClassification('maybe', null, ARMED); // second attempt
    expect(store.jobsNeedingManualApply(ARMED).map((j) => j.cardId)).toEqual(['maybe']);
  });

  it('never lists a job the bot can apply to itself', () => {
    unclassified('ai');
    store.setRoleClassification('ai', 'ai', ARMED);
    expect(store.jobsNeedingManualApply(ARMED)).toHaveLength(0);
  });

  it('keeps the backlog out, exactly as applying does', () => {
    const old = '2026-10-01T00:00:00.000Z';
    store.insertJob(job('old', old), true, old);
    store.setClassification('old', true, old);
    store.setRoleClassification('old', 'other', old);
    expect(store.jobsNeedingManualApply(ARMED)).toHaveLength(0);
  });

  it('mentions a job once, not on every scan', () => {
    unclassified('sales');
    store.setRoleClassification('sales', 'other', ARMED);
    store.markRoleAlerted('sales', ARMED);
    expect(store.jobsNeedingManualApply(ARMED)).toHaveLength(0);
  });

  it('says nothing about a job an application was already attempted on', () => {
    unclassified('sales');
    store.setRoleClassification('sales', 'other', ARMED);
    store.recordApplication({
      cardId: 'sales',
      status: 'failed',
      attemptedAt: 'ts',
      submittedAt: null,
      reason: 'timeout',
      screenshot: null,
    });
    expect(store.jobsNeedingManualApply(ARMED)).toHaveLength(0);
  });
});
