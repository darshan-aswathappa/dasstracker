import { describe, it, expect, vi } from 'vitest';
import {
  whatsappConfigFromEnv,
  buildWhatsAppDigest,
  createWhatsAppNotifier,
  parseRecipients,
} from '../src/core/whatsapp.js';
import type { StoredJob } from '../src/core/types.js';

function job(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    cardId: 'c1',
    title: 'AI Engineer',
    url: 'https://www.3ds.com/jobs/c1',
    applyUrl: 'https://apply/c1',
    location: 'United States, MA, Waltham',
    category: 'Information Technology',
    products: '',
    postedAt: '2026-07-02T00:00:00.000Z',
    firstSeenAt: '2026-07-02T00:00:00.000Z',
    matched: true,
    notifiedAt: null,
    ...overrides,
  };
}

/** Build a fake fetch returning a given status + text body. */
function fakeFetch(status: number, body: string): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

describe('whatsappConfigFromEnv', () => {
  it('returns null when phone or apikey is missing', () => {
    expect(whatsappConfigFromEnv({})).toBeNull();
    expect(whatsappConfigFromEnv({ CALLMEBOT_PHONE: '+1' })).toBeNull();
    expect(whatsappConfigFromEnv({ CALLMEBOT_APIKEY: 'k' })).toBeNull();
  });

  it('strips spaces from the phone number', () => {
    const cfg = whatsappConfigFromEnv({ CALLMEBOT_PHONE: '+34 644 51 95 23', CALLMEBOT_APIKEY: 'k1' });
    expect(cfg).toEqual({ recipients: [{ phone: '+34644519523', apikey: 'k1' }] });
  });

  it('reads multiple phone:apikey pairs from CALLMEBOT_RECIPIENTS', () => {
    const cfg = whatsappConfigFromEnv({
      CALLMEBOT_RECIPIENTS: '15106508661:4664540, 15551234567:5245994',
    });
    expect(cfg).toEqual({
      recipients: [
        { phone: '15106508661', apikey: '4664540' },
        { phone: '15551234567', apikey: '5245994' },
      ],
    });
  });

  it('prefers CALLMEBOT_RECIPIENTS over the legacy single-pair vars', () => {
    const cfg = whatsappConfigFromEnv({
      CALLMEBOT_RECIPIENTS: '111:aaa',
      CALLMEBOT_PHONE: '999',
      CALLMEBOT_APIKEY: 'zzz',
    });
    expect(cfg).toEqual({ recipients: [{ phone: '111', apikey: 'aaa' }] });
  });
});

describe('parseRecipients', () => {
  it('skips entries missing a phone or an apikey', () => {
    expect(parseRecipients('111:aaa,222,:bbb,333:,444:ddd')).toEqual([
      { phone: '111', apikey: 'aaa' },
      { phone: '444', apikey: 'ddd' },
    ]);
  });

  it('de-duplicates by phone and tolerates empty input', () => {
    expect(parseRecipients('111:aaa,111:bbb')).toEqual([{ phone: '111', apikey: 'aaa' }]);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients(null)).toEqual([]);
  });
});

describe('buildWhatsAppDigest', () => {
  it('summarizes a single job', () => {
    const text = buildWhatsAppDigest([job()]);
    expect(text).toContain('1 new 3DS tech job:');
    expect(text).toContain('AI Engineer');
    expect(text).toContain('https://apply/c1');
  });

  it('caps at 10 jobs and notes the remainder', () => {
    const jobs = Array.from({ length: 13 }, (_, i) => job({ cardId: `c${i}`, title: `Job ${i}` }));
    const text = buildWhatsAppDigest(jobs);
    expect(text).toContain('13 new 3DS tech jobs:');
    expect(text).toContain('…and 3 more');
    expect(text).not.toContain('Job 10');
  });
});

describe('createWhatsAppNotifier', () => {
  it('is not configured when config is null', () => {
    const wa = createWhatsAppNotifier(null);
    expect(wa.configured).toBe(false);
    return expect(wa.sendText('hi')).rejects.toThrow(/not configured/i);
  });

  it('sends via CallMeBot with encoded phone, text and apikey', async () => {
    const spy = vi.fn(fakeFetch(200, 'Message queued. You will receive it in a few seconds.'));
    const wa = createWhatsAppNotifier(
      { recipients: [{ phone: '+34644519523', apikey: 'k1' }] },
      spy,
    );
    await wa.sendText('hello world');
    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('phone=%2B34644519523');
    expect(url).toContain('text=hello%20world');
    expect(url).toContain('apikey=k1');
  });

  it('throws a readable error when CallMeBot rejects the key', async () => {
    const wa = createWhatsAppNotifier(
      { recipients: [{ phone: '+1', apikey: 'bad' }] },
      fakeFetch(200, '<b>APIKey not valid</b>'),
    );
    await expect(wa.sendText('x')).rejects.toThrow(/APIKey not valid/i);
  });

  it('throws on non-2xx responses', async () => {
    const wa = createWhatsAppNotifier(
      { recipients: [{ phone: '+1', apikey: 'k' }] },
      fakeFetch(500, 'boom'),
    );
    await expect(wa.sendText('x')).rejects.toThrow(/HTTP 500/);
  });

  it('treats a paused account (HTTP 208, no confirmation) as a failure', async () => {
    const wa = createWhatsAppNotifier(
      { recipients: [{ phone: '+1', apikey: 'k' }] },
      fakeFetch(208, 'Your Account is Paused due to technical issues.'),
    );
    await expect(wa.sendText('x')).rejects.toThrow(/did not confirm delivery/i);
  });

  it('fans out to every recipient with its own key', async () => {
    const spy = vi.fn(fakeFetch(200, 'Message queued.'));
    const wa = createWhatsAppNotifier(
      {
        recipients: [
          { phone: '111', apikey: 'aaa' },
          { phone: '222', apikey: 'bbb' },
        ],
      },
      spy,
    );
    await wa.sendText('hi');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain('phone=111');
    expect(spy.mock.calls[0][0]).toContain('apikey=aaa');
    expect(spy.mock.calls[1][0]).toContain('phone=222');
    expect(spy.mock.calls[1][0]).toContain('apikey=bbb');
  });

  it('succeeds and logs when only some recipients fail', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      (url.includes('phone=111')
        ? { ok: true, status: 200, text: async () => 'Message queued.' }
        : { ok: false, status: 500, text: async () => 'boom' }) as unknown as Response,
    ) as unknown as typeof fetch;
    const logs: string[] = [];
    const wa = createWhatsAppNotifier(
      {
        recipients: [
          { phone: '111', apikey: 'aaa' },
          { phone: '15559998888', apikey: 'bbb' },
        ],
      },
      fetchImpl,
      (m) => logs.push(m),
    );
    await expect(wa.sendText('hi')).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/HTTP 500/);
    // Numbers are masked in logs.
    expect(logs[0]).toContain('…8888');
    expect(logs[0]).not.toContain('15559998888');
  });

  it('throws only when every recipient fails', async () => {
    const wa = createWhatsAppNotifier(
      {
        recipients: [
          { phone: '111', apikey: 'aaa' },
          { phone: '222', apikey: 'bbb' },
        ],
      },
      fakeFetch(500, 'boom'),
    );
    await expect(wa.sendText('hi')).rejects.toThrow(/HTTP 500.*\|.*HTTP 500/s);
  });
});
