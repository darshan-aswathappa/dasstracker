import { describe, it, expect } from 'vitest';
import { parseApplicationProfile, loadApplicationProfile } from '../src/core/profile.js';

const VALID = {
  hearAboutUs: 'Corporate Websites',
  source: 'Dassault Systemes Corporate Site',
  requiresSponsorship: 'Yes',
  legallyAuthorized: 'Yes',
  jobPostingNotification: false,
  gender: 'Female',
  veteranStatus: 'Not a Protected Veteran',
  race: ['Asian'],
  resumeFileName: 'Nireeksha_AI_Engineer.pdf',
};

describe('parseApplicationProfile', () => {
  it('accepts a complete profile', () => {
    expect(parseApplicationProfile(VALID).resumeFileName).toBe('Nireeksha_AI_Engineer.pdf');
  });

  it('rejects a missing required answer', () => {
    const { gender, ...rest } = VALID;
    expect(() => parseApplicationProfile(rest)).toThrow(/gender/);
  });

  it('rejects an eligibility answer the portal does not offer', () => {
    expect(() => parseApplicationProfile({ ...VALID, requiresSponsorship: 'Maybe' })).toThrow(
      /requiresSponsorship/,
    );
  });

  it('rejects an empty race selection', () => {
    expect(() => parseApplicationProfile({ ...VALID, race: [] })).toThrow(/race/);
  });

  it('treats a missing notification flag as unchecked', () => {
    const { jobPostingNotification, ...rest } = VALID;
    expect(parseApplicationProfile(rest).jobPostingNotification).toBe(false);
  });

  it('rejects junk', () => {
    expect(() => parseApplicationProfile(null)).toThrow();
    expect(() => parseApplicationProfile('nope')).toThrow();
  });
});

describe('loadApplicationProfile', () => {
  it('loads and validates the shipped profile', () => {
    const p = loadApplicationProfile();
    expect(p.hearAboutUs).toBe('Corporate Websites');
    expect(p.race).toEqual(['Asian']);
    expect(p.jobPostingNotification).toBe(false);
  });
});
