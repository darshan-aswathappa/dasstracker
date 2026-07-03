import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildUrl,
  parseResponse,
  parseTimestamp,
  parseHit,
  fetchJobs,
} from '../src/core/fetcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/card_search_api.json'), 'utf8'),
);

describe('buildUrl', () => {
  it('encodes filters, sort, and pagination', () => {
    const url = buildUrl({ lang: 'en', type: 'Regular', country: 'United States' }, 50, 25);
    // URLSearchParams encodes spaces as '+', which the 3DS API accepts (verified
    // live). Decode '+' to space before asserting on human-readable content.
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(url).toContain('output_format=json');
    expect(url).toContain('b=50');
    expect(url).toContain('hf=25');
    expect(decoded).toContain('type/Regular');
    expect(decoded).toContain('country/United States');
    expect(decoded).toContain('desc(card_content_start_datetime)');
  });
});

describe('parseTimestamp', () => {
  it('parses 3DS YYYY/MM/DD HH:MM:SS as UTC ISO', () => {
    expect(parseTimestamp('2026/07/02 03:07:05')).toBe('2026-07-02T03:07:05.000Z');
  });
  it('returns empty string on garbage', () => {
    expect(parseTimestamp('not a date')).toBe('');
    expect(parseTimestamp('')).toBe('');
  });
});

describe('parseResponse (real fixture)', () => {
  it('extracts jobs with required fields', () => {
    const jobs = parseResponse(fixture);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.cardId).toBeTruthy();
      expect(j.title).toBeTruthy();
      expect(j.url).toMatch(/^https?:\/\//);
    }
  });

  it('derives category and location from content_categories', () => {
    const jobs = parseResponse(fixture);
    const withCategory = jobs.filter((j) => j.category);
    expect(withCategory.length).toBeGreaterThan(0);
  });

  it('returns [] for malformed input', () => {
    expect(parseResponse({})).toEqual([]);
    expect(parseResponse(null)).toEqual([]);
  });
});

describe('parseHit', () => {
  it('returns null when card_id or title is missing', () => {
    expect(parseHit({ metas: [] })).toBeNull();
    expect(parseHit({ metas: [{ name: 'card_id', value: '9' }] })).toBeNull();
  });
});

describe('fetchJobs (mocked transport)', () => {
  const query = { lang: 'en', type: 'Regular', country: 'United States' };

  it('stops paginating when stopWhen returns true', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: true, json: async () => fixture } as Response;
    }) as unknown as typeof fetch;

    const jobs = await fetchJobs(query, {
      pageSize: 50,
      maxPages: 3,
      fetchImpl,
      stopWhen: () => true, // stop after first page
    });
    expect(calls).toBe(1);
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('throws on non-ok HTTP response', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch;
    await expect(fetchJobs(query, { fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  it('dedups across pages by card_id', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, json: async () => fixture }) as Response) as unknown as typeof fetch;
    // Same fixture every page; without stopWhen it would repeat, but dedup keeps unique set.
    const jobs = await fetchJobs(query, { pageSize: 1000, maxPages: 2, fetchImpl });
    const ids = new Set(jobs.map((j) => j.cardId));
    expect(ids.size).toBe(jobs.length);
  });
});
