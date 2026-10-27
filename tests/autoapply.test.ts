import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/core/store.js';
import { runAutoApply, armedAt, ARMED_AT_KEY } from '../src/core/autoapply.js';
import type { Applicator, ApplyResult } from '../src/core/applicator.js';
import type { Notifier } from '../src/core/notifier.js';
import type { Job, RoleKind, StoredJob } from '../src/core/types.js';
import { loadApplicationProfile } from '../src/core/profile.js';

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
    description: 'Build machine learning models.',
    postedAt: seenAt,
  };
}

const PROFILE = loadApplicationProfile();

/** An applicator that returns canned outcomes and records what it saw. */
function stubApplicator(outcomes: ApplyResult[] | ApplyResult) {
  const seen: string[] = [];
  /** Which resume each application was handed, in order. */
  const resumes: string[] = [];
  const queue = Array.isArray(outcomes) ? [...outcomes] : null;
  const applicator: Applicator = {
    configured: true,
    async apply(j, resumeFileName) {
      seen.push(j.cardId);
      resumes.push(resumeFileName);
      return queue ? (queue.shift() ?? { outcome: 'failed', reason: 'exhausted', screenshots: [] })
                   : (outcomes as ApplyResult);
    },
  };
  return { applicator, seen, resumes };
}

function stubNotifier(options: { failByHand?: boolean } = {}) {
  const sent: Array<{ job: StoredJob; to: string[] }> = [];
  const alerts: Array<{ job: StoredJob; to: string[] }> = [];
  const byHand: Array<{ job: StoredJob; to: string[]; reason: string }> = [];
  const notifier: Notifier = {
    configured: true,
    async send() {},
    async sendApplied(job, to) {
      sent.push({ job, to });
    },
    async sendApplyAlert(job, to) {
      alerts.push({ job, to });
    },
    async sendApplyByHand(job, to, reason) {
      if (options.failByHand) throw new Error('SMTP refused');
      byHand.push({ job, to, reason });
    },
    async verify() {},
  };
  return { notifier, sent, alerts, byHand };
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

  function entryLevel(
    id: string,
    seenAt = '2026-10-12T10:00:00.000Z',
    role: RoleKind | null = 'ai',
  ) {
    store.insertJob(job(id, seenAt), true, seenAt);
    store.setClassification(id, true, seenAt);
    if (role) store.setRoleClassification(id, role, seenAt);
  }

  const base = (over: Partial<Parameters<typeof runAutoApply>[0]> = {}) => ({
    store,
    profile: PROFILE,
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
      async sendApplyAlert() {},
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

describe('an application that may already have been submitted', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => store.close());

  const UNCERTAIN: ApplyResult = {
    outcome: 'uncertain',
    reason: 'Submit was clicked but no Thank You page appeared',
    screenshots: ['/tmp/u.png'],
  };

  function entryLevel(id: string) {
    const seenAt = '2026-10-12T10:00:00.000Z';
    store.insertJob(job(id, seenAt), true, seenAt);
    store.setClassification(id, true, seenAt);
    store.setRoleClassification(id, 'ai', seenAt);
  }

  const base = (over: Record<string, unknown>) => ({
    store,
    profile: PROFILE,
    notifyTo: TO,
    enabled: true,
    maxPerRun: 3,
    now: () => new Date('2026-10-12T09:00:00.000Z'),
    ...over,
  });

  it('is never retried, because retrying could apply a second time', async () => {
    entryLevel('1');
    const { applicator, seen } = stubApplicator(UNCERTAIN);
    const { notifier } = stubNotifier();

    await runAutoApply(base({ applicator, notifier }) as never);
    await runAutoApply(base({ applicator, notifier }) as never);
    await runAutoApply(base({ applicator, notifier }) as never);

    expect(seen).toEqual(['1']); // attempted exactly once, ever
    expect(store.applicationFor('1')?.status).toBe('uncertain');
  });

  it('is not reported as a success', async () => {
    entryLevel('1');
    const { applicator } = stubApplicator(UNCERTAIN);
    const { notifier, sent, alerts } = stubNotifier();

    const s = await runAutoApply(base({ applicator, notifier }) as never);

    expect(s.submitted).toBe(0);
    expect(s.uncertain).toBe(1);
    expect(store.hasApplied('1')).toBe(false);
    // No "applied successfully" mail; an alert instead.
    expect(sent).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].to).toEqual(TO);
  });
});

describe('concurrent runs', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => store.close());

  it('only one of two overlapping runs applies to a job', async () => {
    const seenAt = '2026-10-12T10:00:00.000Z';
    store.insertJob(job('1', seenAt), true, seenAt);
    store.setClassification('1', true, seenAt);
    store.setRoleClassification('1', 'ai', seenAt);

    const seen: string[] = [];
    // Applying is slow, so both runs are in flight at the same time — exactly
    // the window where the cron and a manual /api/scan can collide.
    const slow: Applicator = {
      configured: true,
      async apply(j) {
        seen.push(j.cardId);
        await new Promise((r) => setTimeout(r, 30));
        return OK;
      },
    };
    const { notifier } = stubNotifier();
    const opts = {
      store,
      applicator: slow,
      notifier,
      profile: PROFILE,
      notifyTo: TO,
      enabled: true,
      maxPerRun: 3,
      now: () => new Date('2026-10-12T09:00:00.000Z'),
    };

    await Promise.all([runAutoApply(opts as never), runAutoApply(opts as never)]);

    expect(seen).toEqual(['1']);
  });

  it('a claim is not handed out twice', () => {
    expect(store.claimForApplication('x', 'ts')).toBe(true);
    expect(store.claimForApplication('x', 'ts')).toBe(false);
  });

  it('a claim is released for retry only by an outright failure', () => {
    store.claimForApplication('x', 'ts');
    expect(store.stuckApplications().map((a) => a.cardId)).toEqual(['x']);

    store.recordApplication({
      cardId: 'x',
      status: 'failed',
      attemptedAt: 'ts',
      submittedAt: null,
      reason: 'boom',
      screenshot: null,
    });
    expect(store.claimForApplication('x', 'ts')).toBe(true);

    store.recordApplication({
      cardId: 'x',
      status: 'uncertain',
      attemptedAt: 'ts',
      submittedAt: null,
      reason: 'no confirmation',
      screenshot: null,
    });
    expect(store.claimForApplication('x', 'ts')).toBe(false);
  });
});

describe('choosing which resume to send', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => store.close());

  const SEEN_AT = '2026-10-12T10:00:00.000Z';

  function classified(id: string, role: RoleKind | null, attempts = 0) {
    store.insertJob(job(id, SEEN_AT), true, SEEN_AT);
    store.setClassification(id, true, SEEN_AT);
    if (role) store.setRoleClassification(id, role, SEEN_AT);
    else for (let i = 0; i < attempts; i++) store.setRoleClassification(id, null, SEEN_AT);
  }

  const base = (over: Record<string, unknown>) => ({
    store,
    profile: PROFILE,
    notifyTo: TO,
    enabled: true,
    maxPerRun: 3,
    now: () => new Date('2026-10-12T09:00:00.000Z'),
    ...over,
  });

  it('sends the AI resume to an AI role and the other one to a software role', async () => {
    classified('ai', 'ai');
    classified('swe', 'software');
    const { applicator, seen, resumes } = stubApplicator(OK);
    const { notifier } = stubNotifier();

    await runAutoApply(base({ applicator, notifier }) as never);

    // Both go out; what matters is which document went with which job, not
    // the order two jobs with the same timestamp happen to come back in.
    const pairs = new Map(seen.map((id, i) => [id, resumes[i]]));
    expect(pairs.get('ai')).toBe(PROFILE.resumes.ai);
    expect(pairs.get('swe')).toBe(PROFILE.resumes.software);
    expect(PROFILE.resumes.ai).not.toBe(PROFILE.resumes.software);
  });

  it('never applies to a role that is neither, and says so once', async () => {
    classified('sales', 'other');
    const { applicator, seen } = stubApplicator(OK);
    const { notifier, byHand, sent } = stubNotifier();

    const first = await runAutoApply(base({ applicator, notifier }) as never);
    const second = await runAutoApply(base({ applicator, notifier }) as never);

    expect(seen).toEqual([]); // the browser was never opened for it
    expect(sent).toEqual([]); // and no "applied" mail went out
    expect(first.handedOver).toBe(1);
    expect(second.handedOver).toBe(0); // told once, not on every scan
    expect(byHand).toHaveLength(1);
    expect(byHand[0].to).toEqual(TO);
    expect(byHand[0].reason).toMatch(/neither an AI nor a software/i);
  });

  it('waits out the retry before handing an undecided job over', async () => {
    classified('maybe', null, 1);
    const { applicator, seen } = stubApplicator(OK);
    const { notifier, byHand } = stubNotifier();

    await runAutoApply(base({ applicator, notifier }) as never);
    expect(byHand).toHaveLength(0);
    expect(seen).toEqual([]);

    store.setRoleClassification('maybe', null, SEEN_AT); // the retry came back empty too
    await runAutoApply(base({ applicator, notifier }) as never);

    expect(byHand).toHaveLength(1);
    expect(byHand[0].reason).toMatch(/could not be classified/i);
    expect(seen).toEqual([]);
  });

  it('says nothing yet about a job whose first verdict is still pending', async () => {
    classified('pending', null, 0);
    const { applicator, seen } = stubApplicator(OK);
    const { notifier, byHand } = stubNotifier();

    const s = await runAutoApply(base({ applicator, notifier }) as never);

    expect(seen).toEqual([]);
    expect(byHand).toEqual([]);
    expect(s.handedOver).toBe(0);
  });

  it('tries the hand-over mail again when sending it fails', async () => {
    classified('sales', 'other');
    const { applicator } = stubApplicator(OK);
    const failing = stubNotifier({ failByHand: true });

    const first = await runAutoApply(base({ applicator, notifier: failing.notifier }) as never);
    expect(first.handedOver).toBe(0);

    // The mark is only written once the mail is out, so the next scan retries.
    const working = stubNotifier();
    const second = await runAutoApply(base({ applicator, notifier: working.notifier }) as never);
    expect(second.handedOver).toBe(1);
    expect(working.byHand).toHaveLength(1);
  });

  it('hands nothing over while auto-apply is switched off', async () => {
    classified('sales', 'other');
    const { applicator } = stubApplicator(OK);
    const { notifier, byHand } = stubNotifier();

    await runAutoApply(base({ applicator, notifier, enabled: false }) as never);

    expect(byHand).toEqual([]);
  });

  it('applies to the AI job even when another job needs a human', async () => {
    classified('sales', 'other');
    classified('ai', 'ai');
    const { applicator, seen, resumes } = stubApplicator(OK);
    const { notifier, byHand } = stubNotifier();

    const s = await runAutoApply(base({ applicator, notifier }) as never);

    expect(seen).toEqual(['ai']);
    expect(resumes).toEqual([PROFILE.resumes.ai]);
    expect(byHand.map((h) => h.job.cardId)).toEqual(['sales']);
    expect(s.submitted).toBe(1);
    expect(s.handedOver).toBe(1);
  });
});
