import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store.js';
import { classifyPendingJobs, classifyPendingRoles } from '../src/core/classify.js';
import type { EntryLevelVerdict, JevClassifier, RoleVerdict } from '../src/core/jev.js';
import type { Job } from '../src/core/types.js';

function job(id: string, experience: string): Job {
  return {
    cardId: id,
    title: `Job ${id}`,
    url: `https://x/${id}`,
    applyUrl: '',
    location: 'US',
    category: 'Research & Development',
    products: '',
    experience,
    description: `What job ${id} involves.`,
    postedAt: '2026-07-02T03:00:00.000Z',
  };
}

/** A classifier that answers from a lookup table and counts its calls. */
function stubJev(table: Record<string, EntryLevelVerdict>) {
  const calls: string[] = [];
  const classifier: JevClassifier = {
    configured: true,
    async classify(experience) {
      calls.push(experience);
      return table[experience] ?? 'unknown';
    },
    async classifyAll(values) {
      const out = new Map<string, EntryLevelVerdict>();
      for (const v of [...new Set(values)]) out.set(v, await this.classify(v));
      return out;
    },
    async classifyRole() {
      return 'unknown';
    },
  };
  return { classifier, calls };
}

const TABLE: Record<string, EntryLevelVerdict> = {
  '0 to 3 years': 'entry',
  '4 to 5 years': 'senior',
  'Not specified': 'unknown',
};

describe('classifyPendingJobs', () => {
  it('writes a verdict for every pending job', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', '0 to 3 years'), true, 'now');
    store.insertJob(job('2', '4 to 5 years'), true, 'now');
    const { classifier } = stubJev(TABLE);

    const n = await classifyPendingJobs(store, classifier, () => 'ts');

    expect(n).toBe(2);
    const byId = new Map(store.recentJobs().map((j) => [j.cardId, j]));
    expect(byId.get('1')?.entryLevel).toBe(true);
    expect(byId.get('2')?.entryLevel).toBe(false);
    store.close();
  });

  it('asks the model once per distinct band, not once per job', async () => {
    const store = new Store(':memory:');
    for (let i = 0; i < 6; i++) store.insertJob(job(String(i), '0 to 3 years'), true, 'now');
    store.insertJob(job('x', '4 to 5 years'), true, 'now');
    const { classifier, calls } = stubJev(TABLE);

    await classifyPendingJobs(store, classifier, () => 'ts');

    expect(calls.sort()).toEqual(['0 to 3 years', '4 to 5 years']);
    store.close();
  });

  it('records an undecided verdict so the job is not retried forever', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', 'Not specified'), true, 'now');
    const { classifier } = stubJev(TABLE);

    await classifyPendingJobs(store, classifier, () => 'ts');
    expect(store.recentJobs()[0].entryLevel).toBeNull();
    expect(store.jobsNeedingClassification()).toHaveLength(0);
    store.close();
  });

  it('does nothing when the classifier is not configured', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', '0 to 3 years'), true, 'now');
    const { classifier, calls } = stubJev(TABLE);

    const n = await classifyPendingJobs(store, { ...classifier, configured: false }, () => 'ts');

    expect(n).toBe(0);
    expect(calls).toHaveLength(0);
    expect(store.jobsNeedingClassification()).toHaveLength(1); // still pending
    store.close();
  });

  it('leaves a job pending when the model call fails, so it retries later', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', '0 to 3 years'), true, 'now');
    const failing: JevClassifier = {
      configured: true,
      async classify() {
        throw new Error('Jev HTTP 502');
      },
      async classifyAll() {
        throw new Error('Jev HTTP 502');
      },
    };
    const logs: string[] = [];

    const n = await classifyPendingJobs(store, failing, () => 'ts', (m) => logs.push(m));

    expect(n).toBe(0);
    expect(store.jobsNeedingClassification()).toHaveLength(1);
    expect(logs.join(' ')).toMatch(/502/);
    store.close();
  });
});

/** A classifier that answers the role question from a table of titles. */
function stubRoleJev(table: Record<string, RoleVerdict>, failOn: string[] = []) {
  const calls: string[] = [];
  const classifier: JevClassifier = {
    configured: true,
    async classify() {
      return 'unknown';
    },
    async classifyAll() {
      return new Map();
    },
    async classifyRole(input) {
      calls.push(input.title);
      if (failOn.includes(input.title)) throw new Error('Jev HTTP 503');
      return table[input.title] ?? 'unknown';
    },
  };
  return { classifier, calls };
}

describe('classifyPendingRoles', () => {
  it('records the verdict for each matched job', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', '0 to 3 years'), true, 'now');
    store.insertJob(job('2', '0 to 3 years'), true, 'now');
    const { classifier, calls } = stubRoleJev({ 'Job 1': 'ai', 'Job 2': 'software' });

    const decided = await classifyPendingRoles(store, classifier, () => 'at');

    expect(decided).toBe(2);
    expect(calls.sort()).toEqual(['Job 1', 'Job 2']);
    const byId = new Map(store.recentJobs().map((j) => [j.cardId, j]));
    expect(byId.get('1')?.roleKind).toBe('ai');
    expect(byId.get('2')?.roleKind).toBe('software');
    expect(byId.get('1')?.roleClassifiedAt).toBe('at');
    store.close();
  });

  it('never asks about an unmatched job', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('skip', '0 to 3 years'), false, 'now');
    const { classifier, calls } = stubRoleJev({ 'Job skip': 'ai' });

    await classifyPendingRoles(store, classifier, () => 'at');

    expect(calls).toEqual([]);
    store.close();
  });

  it('asks again once about a job it could not decide, then gives up', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', '0 to 3 years'), true, 'now');
    const { classifier, calls } = stubRoleJev({});

    await classifyPendingRoles(store, classifier, () => 'at');
    await classifyPendingRoles(store, classifier, () => 'at');
    await classifyPendingRoles(store, classifier, () => 'at');

    // Two attempts, then the job is left for a human rather than asked forever.
    expect(calls).toEqual(['Job 1', 'Job 1']);
    expect(store.recentJobs()[0].roleKind).toBeNull();
    expect(store.recentJobs()[0].roleAttempts).toBe(2);
    store.close();
  });

  it('counts a failed call as an attempt, so an outage surfaces', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', '0 to 3 years'), true, 'now');
    const { classifier } = stubRoleJev({}, ['Job 1']);

    const decided = await classifyPendingRoles(store, classifier, () => 'at');

    expect(decided).toBe(0);
    expect(store.recentJobs()[0].roleAttempts).toBe(1);
    store.close();
  });

  it('lets one failed posting cost only itself', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', '0 to 3 years'), true, 'now');
    store.insertJob(job('2', '0 to 3 years'), true, 'now');
    const { classifier } = stubRoleJev({ 'Job 2': 'software' }, ['Job 1']);

    const decided = await classifyPendingRoles(store, classifier, () => 'at');

    expect(decided).toBe(1);
    const byId = new Map(store.recentJobs().map((j) => [j.cardId, j]));
    expect(byId.get('2')?.roleKind).toBe('software');
    store.close();
  });

  it('does nothing when Jev is switched off', async () => {
    const store = new Store(':memory:');
    store.insertJob(job('1', '0 to 3 years'), true, 'now');
    const { classifier, calls } = stubRoleJev({ 'Job 1': 'ai' });

    const decided = await classifyPendingRoles(
      store,
      { ...classifier, configured: false },
      () => 'at',
    );

    expect(decided).toBe(0);
    expect(calls).toEqual([]);
    store.close();
  });
});
