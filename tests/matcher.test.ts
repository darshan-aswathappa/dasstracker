import { describe, it, expect } from 'vitest';
import { matchJob } from '../src/core/matcher.js';
import type { Job } from '../src/core/types.js';

function job(overrides: Partial<Job>): Job {
  return {
    cardId: '1',
    title: '',
    url: '',
    applyUrl: '',
    location: '',
    category: '',
    products: '',
    postedAt: '',
    ...overrides,
  };
}

const KEYWORDS = ['software', 'engineer', 'AI', 'ML', 'full stack', 'developer'];
const CATEGORIES = ['Research & Development', 'Information Technology'];

describe('matchJob', () => {
  it('matches a keyword in the title case-insensitively', () => {
    const r = matchJob(job({ title: 'Senior Software Engineer' }), KEYWORDS, CATEGORIES);
    expect(r.matched).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('does NOT match "AI" embedded inside another word (MAINTENANCE)', () => {
    const r = matchJob(job({ title: 'Maintenance Technician' }), ['AI'], []);
    expect(r.matched).toBe(false);
  });

  it('matches standalone acronym "AI"', () => {
    const r = matchJob(job({ title: 'AI Research Scientist' }), ['AI'], []);
    expect(r.matched).toBe(true);
  });

  it('does NOT match "ML" inside "HTML"', () => {
    const r = matchJob(job({ title: 'HTML Content Editor' }), ['ML'], []);
    expect(r.matched).toBe(false);
  });

  it('matches multi-word phrase "full stack"', () => {
    const r = matchJob(job({ title: 'Full Stack Developer' }), ['full stack'], []);
    expect(r.matched).toBe(true);
  });

  it('matches on category whitelist even without keyword hit', () => {
    const r = matchJob(
      job({ title: 'Accountant', category: 'Information Technology' }),
      KEYWORDS,
      CATEGORIES,
    );
    expect(r.matched).toBe(true);
    expect(r.reasons.some((x) => x.includes('category'))).toBe(true);
  });

  it('does not match a non-technical sales role', () => {
    const r = matchJob(
      job({ title: 'Account Executive', category: 'Sales' }),
      KEYWORDS,
      CATEGORIES,
    );
    expect(r.matched).toBe(false);
  });

  it('ignores empty keywords', () => {
    const r = matchJob(job({ title: 'Anything' }), ['', '   '], []);
    expect(r.matched).toBe(false);
  });
});
