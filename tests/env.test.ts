import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/core/env.js';
import { mailerConfigFromEnv } from '../src/core/notifier.js';

describe('parseEnv', () => {
  it('parses KEY=VALUE pairs, skipping comments and blanks', () => {
    const env = parseEnv(`
      # comment
      GMAIL_USER=you@gmail.com

      PORT=3000
    `);
    expect(env.GMAIL_USER).toBe('you@gmail.com');
    expect(env.PORT).toBe('3000');
  });

  it('strips surrounding quotes but keeps inner content', () => {
    const env = parseEnv(`GMAIL_APP_PASSWORD="abcd efgh ijkl mnop"`);
    expect(env.GMAIL_APP_PASSWORD).toBe('abcd efgh ijkl mnop');
  });

  it('keeps = signs inside values', () => {
    const env = parseEnv('TOKEN=a=b=c');
    expect(env.TOKEN).toBe('a=b=c');
  });
});

describe('mailerConfigFromEnv', () => {
  it('returns null when credentials are missing', () => {
    expect(mailerConfigFromEnv({}, null)).toBeNull();
    expect(mailerConfigFromEnv({ GMAIL_USER: 'x@y.com' }, null)).toBeNull();
  });

  it('strips whitespace from the app password (Gmail 4-group format)', () => {
    const cfg = mailerConfigFromEnv(
      { GMAIL_USER: 'x@y.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' },
      null,
    );
    expect(cfg?.appPassword).toBe('abcdefghijklmnop');
  });

  it('defaults recipient to GMAIL_USER, honors override', () => {
    const base = { GMAIL_USER: 'x@y.com', GMAIL_APP_PASSWORD: 'pw' };
    expect(mailerConfigFromEnv(base, null)?.to).toBe('x@y.com');
    expect(mailerConfigFromEnv(base, 'other@z.com')?.to).toBe('other@z.com');
  });
});
