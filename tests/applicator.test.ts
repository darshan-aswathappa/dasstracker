import { describe, it, expect } from 'vitest';
import {
  isThankYouPage,
  findResumeRow,
  applicatorConfigFromEnv,
  autoApplyEnabled,
  maxApplicationsPerScan,
  createApplicator,
  isExpectedHost,
  redactUrl,
  isNavigationTeardown,
} from '../src/core/applicator.js';
import { loadApplicationProfile } from '../src/core/profile.js';
import type { Job } from '../src/core/types.js';

const profile = loadApplicationProfile();

const job: Job = {
  cardId: '550021',
  title: 'AI Engineer',
  url: 'https://www.3ds.com/careers/jobs/ai-engineer-550021',
  applyUrl: 'https://talentacquisition.3ds.com/careersection/qa/jobapply.ftl?job=550021&lang=en',
  location: 'US, MA, Waltham',
  category: 'Research & Development',
  products: '',
  experience: '0 to 3 years',
  description: 'Build machine learning models.',
  postedAt: '2026-10-11T00:00:00.000Z',
};

describe('isThankYouPage', () => {
  it('recognises the real confirmation page', () => {
    expect(
      isThankYouPage(
        'Process completed Thank You Thank you for your interest in joining Dassault ' +
          'Systemes! View My Submissions',
      ),
    ).toBe(true);
  });

  it('does not mistake a mid-flow page that happens to say thank you', () => {
    expect(isThankYouPage('Thank you for your patience while the page loads')).toBe(false);
  });

  it('does not treat the review page as success', () => {
    expect(isThankYouPage('Review and Submit — click Submit to finish')).toBe(false);
  });
});

describe('findResumeRow', () => {
  const files = [
    'Nireeksha_Huns_Resume_Dassault.pdf',
    'Nireeksha_AI_Engineer.pdf',
    'Nireeksha_Huns_Resume.pdf',
  ];

  it('finds the wanted resume', () => {
    expect(findResumeRow(files, 'Nireeksha_AI_Engineer.pdf')).toBe(1);
  });

  it('matches exactly, so a near-identical name is not picked by mistake', () => {
    expect(findResumeRow(files, 'Nireeksha_Huns_Resume')).toBe(-1);
    expect(findResumeRow(files, 'Nireeksha_Huns_Resume.pdf')).toBe(2);
  });

  it('reports -1 when the file is not on the account', () => {
    expect(findResumeRow(files, 'Missing.pdf')).toBe(-1);
    expect(findResumeRow([], 'Nireeksha_AI_Engineer.pdf')).toBe(-1);
  });
});

describe('applicatorConfigFromEnv', () => {
  it('is null without credentials', () => {
    expect(applicatorConfigFromEnv({}, profile)).toBeNull();
    expect(applicatorConfigFromEnv({ TALEO_USERNAME: 'u' }, profile)).toBeNull();
    expect(applicatorConfigFromEnv({ TALEO_PASSWORD: 'p' }, profile)).toBeNull();
  });

  it('builds a config and defaults to a live, headless run', () => {
    const cfg = applicatorConfigFromEnv({ TALEO_USERNAME: 'u', TALEO_PASSWORD: 'p' }, profile);
    expect(cfg?.username).toBe('u');
    expect(cfg?.dryRun).toBe(false);
    expect(cfg?.headless).toBe(true);
  });

  it('honours the dry-run switch', () => {
    const cfg = applicatorConfigFromEnv(
      { TALEO_USERNAME: 'u', TALEO_PASSWORD: 'p', AUTO_APPLY_DRY_RUN: '1' },
      profile,
    );
    expect(cfg?.dryRun).toBe(true);
  });
});

describe('arming and rate limits', () => {
  it('stays disarmed unless explicitly switched on', () => {
    expect(autoApplyEnabled({})).toBe(false);
    expect(autoApplyEnabled({ AUTO_APPLY_ENABLED: 'false' })).toBe(false);
    expect(autoApplyEnabled({ AUTO_APPLY_ENABLED: '0' })).toBe(false);
    expect(autoApplyEnabled({ AUTO_APPLY_ENABLED: '1' })).toBe(true);
    expect(autoApplyEnabled({ AUTO_APPLY_ENABLED: 'true' })).toBe(true);
  });

  it('caps applications per scan, with a conservative default', () => {
    expect(maxApplicationsPerScan({})).toBe(3);
    expect(maxApplicationsPerScan({ AUTO_APPLY_MAX_PER_SCAN: '5' })).toBe(5);
    expect(maxApplicationsPerScan({ AUTO_APPLY_MAX_PER_SCAN: 'nonsense' })).toBe(3);
    expect(maxApplicationsPerScan({ AUTO_APPLY_MAX_PER_SCAN: '-2' })).toBe(3);
  });
});

describe('createApplicator without credentials', () => {
  it('reports itself unconfigured and refuses to run', async () => {
    const applicator = createApplicator(null);
    expect(applicator.configured).toBe(false);
    const result = await applicator.apply(job, profile.resumes.ai);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/not configured/i);
  });
});

describe('isExpectedHost', () => {
  it('accepts the real portal', () => {
    expect(
      isExpectedHost(
        'https://talentacquisition.3ds.com/careersection/qa/jobapply.ftl?job=1',
        'talentacquisition.3ds.com',
      ),
    ).toBe(true);
  });

  it('rejects a look-alike that a substring check would have let through', () => {
    // applyUrl comes from the 3DS search API — data we do not control — and
    // the credentials are typed into whatever it loads.
    expect(
      isExpectedHost(
        'https://talentacquisition.3ds.com.evil.test/login',
        'talentacquisition.3ds.com',
      ),
    ).toBe(false);
    expect(
      isExpectedHost('https://evil.test/?x=talentacquisition.3ds.com', 'talentacquisition.3ds.com'),
    ).toBe(false);
    expect(
      isExpectedHost('https://evil.test/talentacquisition.3ds.com', 'talentacquisition.3ds.com'),
    ).toBe(false);
  });

  it('rejects credentials-in-URL smuggling of the expected host', () => {
    expect(
      isExpectedHost(
        'https://talentacquisition.3ds.com@evil.test/login',
        'talentacquisition.3ds.com',
      ),
    ).toBe(false);
  });

  it('ignores case and rejects junk', () => {
    expect(isExpectedHost('https://TalentAcquisition.3DS.com/x', 'talentacquisition.3ds.com')).toBe(
      true,
    );
    expect(isExpectedHost('not a url', 'talentacquisition.3ds.com')).toBe(false);
    expect(isExpectedHost('', 'talentacquisition.3ds.com')).toBe(false);
  });
});

describe('redactUrl', () => {
  it('strips credentials smuggled into a URL', () => {
    const out = redactUrl('https://user:hunter2@talentacquisition.3ds.com/careersection/x');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('user');
    expect(out).toContain('talentacquisition.3ds.com');
    expect(out).toContain('credentials removed');
  });

  it('leaves an ordinary URL alone', () => {
    const url = 'https://talentacquisition.3ds.com/careersection/qa/jobapply.ftl?job=550021';
    expect(redactUrl(url)).toContain('job=550021');
  });

  it('does not leak junk it cannot parse', () => {
    expect(redactUrl('not a url')).toBe('<unparseable url>');
  });
});

describe('isNavigationTeardown', () => {
  it('recognises a context destroyed by the navigation we triggered', () => {
    expect(
      isNavigationTeardown(
        new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'),
      ),
    ).toBe(true);
    expect(isNavigationTeardown(new Error('Target closed'))).toBe(true);
    expect(isNavigationTeardown(new Error('frame was detached'))).toBe(true);
  });

  it('does not swallow a genuine scripting error', () => {
    expect(isNavigationTeardown(new Error('ReferenceError: __name is not defined'))).toBe(false);
    expect(isNavigationTeardown(new Error('TypeError: hit.click is not a function'))).toBe(false);
    expect(isNavigationTeardown('nope')).toBe(false);
  });
});
