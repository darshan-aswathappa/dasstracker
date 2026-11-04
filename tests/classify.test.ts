import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store.js';
import { classifyPendingJobs } from '../src/core/classify.js';
import type { EntryLevelVerdict, JevClassifier } from '../src/core/jev.js';
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
