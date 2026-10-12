import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/core/store.js';
import { runAutoApply, armedAt, ARMED_AT_KEY } from '../src/core/autoapply.js';
import type { Applicator, ApplyResult } from '../src/core/applicator.js';
import type { Notifier } from '../src/core/notifier.js';
import type { Job, StoredJob } from '../src/core/types.js';

function job(id: string, seenAt = '2026-10-12T10:00:00.000Z'): Job {
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

/** An applicator that returns canned outcomes and records what it saw. */
function stubApplicator(outcomes: ApplyResult[] | ApplyResult) {
  const seen: string[] = [];
  const queue = Array.isArray(outcomes) ? [...outcomes] : null;
  const applicator: Applicator = {
    configured: true,
    async apply(j) {
      seen.push(j.cardId);
      return queue ? (queue.shift() ?? { outcome: 'failed', reason: 'exhausted', screenshots: [] })
                   : (outcomes as ApplyResult);
    },
  };
  return { applicator, seen };
}

function stubNotifier() {
  const sent: Array<{ job: StoredJob; to: string[] }> = [];
  const notifier: Notifier = {
    configured: true,
    async send() {},
    async sendApplied(job, to) {
      sent.push({ job, to });
    },
    async verify() {},
  };
  return { notifier, sent };
}

const OK: ApplyResult = { outcome: 'submitted', reason: null, screenshots: ['/tmp/a.png'] };
const BAD: ApplyResult = { outcome: 'failed', reason: 'selector missing', screenshots: [] };
const TO = ['darshanaswath@gmail.com', 'huns.n@northeastern.edu'];

describe('runAutoApply', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => store.close());

  function entryLevel(id: string, seenAt = '2026-10-12T10:00:00.000Z') {
    store.insertJob(job(id, seenAt), true, seenAt);
    store.setClassification(id, true, seenAt);
  }

  const base = (over: Partial<Parameters<typeof runAutoApply>[0]> = {}) => ({
    store,
    notifyTo: TO,
    enabled: true,
    maxPerRun: 3,
    now: () => new Date('2026-10-12T09:00:00.000Z'),
    ...over,
  });

  it('does nothing at all when disabled', async () => {
    entryLevel('1');
    const { applicator, seen } = stubApplicator(OK);
    const { notifier, sent } = stubNotifier();

    const s = await runAutoApply(base({ applicator, notifier, enabled: false }) as never);

    expect(seen).toEqual([]);
    expect(sent).toEqual([]);
    expect(s.attempted).toBe(0);
    // Not even the arming mark is written, so enabling later still skips the backlog.
    expect(store.getSetting(ARMED_AT_KEY)).toBeNull();
  });

  it('submits an eligible job and emails both recipients', async () => {
    entryLevel('1', '2026-10-12T10:00:00.000Z');
    const { applicator, seen } = stubApplicator(OK);
    const { notifier, sent } = stubNotifier();

    const s = await runAutoApply(base({ applicator, notifier }) as never);

    expect(seen).toEqual(['1']);
    expect(s.submitted).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(TO);
    expect(store.hasApplied('1')).toBe(true);
  });

  it('skips the backlog that predates arming', async () => {
    entryLevel('old', '2026-10-01T00:00:00.000Z');
    const { applicator, seen } = stubApplicator(OK);
    const { notifier } = stubNotifier();

    const s = await runAutoApply(base({ applicator, notifier }) as never);

    expect(seen).toEqual([]);
    expect(s.attempted).toBe(0);
  });

  it('never applies to the same job twice across runs', async () => {
    entryLevel('1');
    const { applicator, seen } = stubApplicator(OK);
    const { notifier } = stubNotifier();

    await runAutoApply(base({ applicator, notifier }) as never);
    await runAutoApply(base({ applicator, notifier }) as never);

    expect(seen).toEqual(['1']);
  });

  it('records a failure without claiming success, and does not email', async () => {
    entryLevel('1');
    const { applicator } = stubApplicator(BAD);
    const { notifier, sent } = stubNotifier();

    const s = await runAutoApply(base({ applicator, notifier }) as never);

    expect(s.failed).toBe(1);
    expect(s.submitted).toBe(0);
    expect(sent).toEqual([]);
    expect(store.hasApplied('1')).toBe(false);
    expect(store.applicationFor('1')?.reason).toBe('selector missing');
  });

  it('retries a failed job on a later run', async () => {
    entryLevel('1');
    const { applicator, seen } = stubApplicator([BAD, OK]);
    const { notifier } = stubNotifier();

    await runAutoApply(base({ applicator, notifier }) as never);
    await runAutoApply(base({ applicator, notifier }) as never);

    expect(seen).toEqual(['1', '1']);
    expect(store.hasApplied('1')).toBe(true);
  });

  it('honours the per-run cap', async () => {
    for (let i = 0; i < 5; i++) entryLevel(`j${i}`);
    const { applicator, seen } = stubApplicator(OK);
    const { notifier } = stubNotifier();

    const s = await runAutoApply(base({ applicator, notifier, maxPerRun: 2 }) as never);

    expect(seen).toHaveLength(2);
    expect(s.attempted).toBe(2);
  });

  it('keeps the application on record when the confirmation email fails', async () => {
    entryLevel('1');
    const { applicator } = stubApplicator(OK);
    const notifier: Notifier = {
      configured: true,
      async send() {},
      async sendApplied() {
        throw new Error('SMTP blocked');
      },
      async verify() {},
    };
    const logs: string[] = [];

    const s = await runAutoApply(
      base({ applicator, notifier, log: (m: string) => logs.push(m) }) as never,
    );

    // The submission really happened; a mail failure must not undo it or
    // cause a retry that would apply a second time.
    expect(s.submitted).toBe(1);
    expect(store.hasApplied('1')).toBe(true);
    expect(logs.join(' ')).toMatch(/SMTP blocked/);
  });

  it('does nothing when credentials are missing, even if enabled', async () => {
    entryLevel('1');
    const applicator: Applicator = {
      configured: false,
      async apply() {
        throw new Error('should never be called');
      },
    };
    const { notifier } = stubNotifier();
    const logs: string[] = [];

    const s = await runAutoApply(base({ applicator, notifier, log: (m: string) => logs.push(m) }) as never);

    expect(s.attempted).toBe(0);
    expect(logs.join(' ')).toMatch(/no portal credentials/i);
  });
});

describe('armedAt', () => {
  it('records the moment of arming once and then keeps it', () => {
    const store = new Store(':memory:');
    const first = armedAt(store, new Date('2026-10-12T09:00:00.000Z'));
    const second = armedAt(store, new Date('2026-11-01T00:00:00.000Z'));
    expect(first).toBe('2026-10-12T09:00:00.000Z');
    expect(second).toBe(first);
    store.close();
  });
});
