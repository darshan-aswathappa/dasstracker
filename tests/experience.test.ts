import { describe, it, expect } from 'vitest';
import { parseExperienceFromHtml, fetchExperience } from '../src/core/experience.js';

const LIVE_PAGE = `
<div class="key-jobdetails-item" data-v-84fe375c>
  <div class="key-jobdetails-item-title" data-v-84fe375c>Product:</div>
  <div class="key-jobdetails-item-description" data-v-84fe375c>BIOVIA</div>
</div><div class="key-jobdetails-item" data-v-84fe375c>
  <div class="key-jobdetails-item-title" data-v-84fe375c>Experience level:</div>
  <div class="key-jobdetails-item-description" data-v-84fe375c>0 to 3 years</div>
</div>`;

// A delisted posting falls back to the search page, which lists every band as
// a filter option but never labels one as this job's experience level.
const DELISTED_PAGE = `
<ul class="facets"><li>0 to 3 years</li><li>4 to 5 years</li><li>More than 15 years</li></ul>`;

describe('parseExperienceFromHtml', () => {
  it('reads the labeled experience level off a live posting', () => {
    expect(parseExperienceFromHtml(LIVE_PAGE)).toBe('0 to 3 years');
  });

  it('returns empty for a delisted posting that only shows filter options', () => {
    expect(parseExperienceFromHtml(DELISTED_PAGE)).toBe('');
  });

  it('returns empty for junk input', () => {
    expect(parseExperienceFromHtml('')).toBe('');
    expect(parseExperienceFromHtml('<html></html>')).toBe('');
  });

  it('tolerates attribute and whitespace variation between the two divs', () => {
    const html =
      '<div class="key-jobdetails-item-title">Experience level:</div>\n\n' +
      '  <div class="key-jobdetails-item-description">11 to 15 years</div>';
    expect(parseExperienceFromHtml(html)).toBe('11 to 15 years');
  });
});

describe('fetchExperience', () => {
  it('returns the band from a fetched page', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, text: async () => LIVE_PAGE }) as Response) as unknown as typeof fetch;
    expect(await fetchExperience('https://x/job', fetchImpl)).toBe('0 to 3 years');
  });

  it('returns empty rather than throwing when the page is gone', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 404, text: async () => '' }) as Response) as unknown as typeof fetch;
    expect(await fetchExperience('https://x/job', fetchImpl)).toBe('');
  });

  it('returns empty when the request itself fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchExperience('https://x/job', fetchImpl)).toBe('');
  });

  it('returns empty for a job with no URL', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: true, status: 200, text: async () => LIVE_PAGE } as Response;
    }) as unknown as typeof fetch;
    expect(await fetchExperience('', fetchImpl)).toBe('');
    expect(calls).toBe(0);
  });
});
