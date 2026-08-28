import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/core/env.js';
import { isValidEmail, mailerConfigFromEnv, parseEmailList } from '../src/core/notifier.js';

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
    expect(mailerConfigFromEnv(base, null)?.to).toEqual(['x@y.com']);
    expect(mailerConfigFromEnv(base, 'other@z.com')?.to).toEqual(['other@z.com']);
  });

  it('accepts multiple recipients from an override or NOTIFY_TO', () => {
    const base = { GMAIL_USER: 'x@y.com', GMAIL_APP_PASSWORD: 'pw' };
    expect(mailerConfigFromEnv(base, ['a@x.com', 'b@x.com'])?.to).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
    // A comma-separated string is the shape the dashboard and .env both produce.
    expect(mailerConfigFromEnv(base, 'a@x.com, b@x.com')?.to).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
    expect(
      mailerConfigFromEnv({ ...base, NOTIFY_TO: 'a@x.com,b@x.com' }, null)?.to,
    ).toEqual(['a@x.com', 'b@x.com']);
  });

  it('falls back to GMAIL_USER when the recipient list is empty', () => {
    const base = { GMAIL_USER: 'x@y.com', GMAIL_APP_PASSWORD: 'pw' };
    expect(mailerConfigFromEnv(base, [])?.to).toEqual(['x@y.com']);
    expect(mailerConfigFromEnv(base, '  ,  ')?.to).toEqual(['x@y.com']);
  });
});

describe('parseEmailList', () => {
  it('trims, splits on commas/semicolons/newlines, and drops blanks', () => {
    expect(parseEmailList(' a@x.com , b@x.com ;c@x.com\nd@x.com,,')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
  });

  it('de-duplicates case-insensitively, keeping the casing given', () => {
    expect(parseEmailList('A@x.com, a@X.com, b@x.com')).toEqual(['A@x.com', 'b@x.com']);
  });

  it('normalizes null, undefined, and the legacy bare-string form', () => {
    expect(parseEmailList(null)).toEqual([]);
    expect(parseEmailList(undefined)).toEqual([]);
    expect(parseEmailList('solo@x.com')).toEqual(['solo@x.com']);
  });
});

describe('isValidEmail', () => {
  it('accepts plain addresses and rejects malformed ones', () => {
    expect(isValidEmail('a@x.com')).toBe(true);
    expect(isValidEmail('a.b+tag@sub.x.co.uk')).toBe(true);
    for (const bad of ['a@x', 'a@@x.com', 'no-at-sign', 'a b@x.com', '@x.com', 'a@.com']) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });
});
