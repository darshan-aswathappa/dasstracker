import { describe, it, expect, vi } from 'vitest';
import {
  whatsappConfigFromEnv,
  buildWhatsAppDigest,
  createWhatsAppNotifier,
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
    expect(cfg).toEqual({ phone: '+34644519523', apikey: 'k1' });
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
    const wa = createWhatsAppNotifier({ phone: '+34644519523', apikey: 'k1' }, spy);
    await wa.sendText('hello world');
    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('phone=%2B34644519523');
    expect(url).toContain('text=hello%20world');
    expect(url).toContain('apikey=k1');
  });

  it('throws a readable error when CallMeBot rejects the key', async () => {
    const wa = createWhatsAppNotifier(
      { phone: '+1', apikey: 'bad' },
      fakeFetch(200, '<b>APIKey not valid</b>'),
    );
    await expect(wa.sendText('x')).rejects.toThrow(/APIKey not valid/i);
  });

  it('throws on non-2xx responses', async () => {
    const wa = createWhatsAppNotifier({ phone: '+1', apikey: 'k' }, fakeFetch(500, 'boom'));
    await expect(wa.sendText('x')).rejects.toThrow(/HTTP 500/);
  });
});
