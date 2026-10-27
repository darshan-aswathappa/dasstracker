import { describe, it, expect } from 'vitest';
import {
  reviewProblems,
  identifyStep,
  statedJobNumber,
  wrongJobNumber,
} from '../src/core/review.js';
import { loadApplicationProfile } from '../src/core/profile.js';

const profile = loadApplicationProfile();
const RESUME = profile.resumes.ai;

/** The real review page's text, as the probe captured it. */
const GOOD_REVIEW = `
  The following information will be submitted after you click the Submit button.
  Personal Information | EDIT
  Full Name Nireeksha Huns
  Phone Country Code + 1
  Cellular Number 5103927822
  Email Address nireeksha.huns@outlook.com
  Will you now or in the future require sponsorship for employment visa status? Yes
  Are you legally authorized to work in the country for which you are applying? Yes
  Job Posting Notification
  Send an email notification whenever a new position matching this profile is posted. No
  Diversity - Part 1 | EDIT
  Gender Female
  Veterans Invitation to Self Identify Not a Protected Veteran
  Race (Please select the ethnic group(s) that apply to you) Asian
  File Attachments | EDIT
  Relevant Files Resume File Name Date Comments
  No No Nireeksha_Huns_Resume_Dassault.pdf 10/8/26
  Yes Yes Nireeksha_AI_Engineer.pdf 10/12/26
  No No Nireeksha_Huns_Resume.pdf 10/12/26
  SUBMIT SAVE AS DRAFT`;

describe('reviewProblems', () => {
  it('passes the real review page', () => {
    expect(reviewProblems(GOOD_REVIEW, profile, RESUME)).toEqual([]);
  });

  it('refuses when the resume is not listed', () => {
    const text = GOOD_REVIEW.replace(/Nireeksha_AI_Engineer\.pdf/g, 'Someone_Else.pdf');
    expect(reviewProblems(text, profile, RESUME)).toContain(
      'review does not list the resume Nireeksha_AI_Engineer.pdf',
    );
  });

  it('refuses when a carried-over answer disagrees with the profile', () => {
    const text = GOOD_REVIEW.replace(
      'Are you legally authorized to work in the country for which you are applying? Yes',
      'Are you legally authorized to work in the country for which you are applying? No',
    );
    expect(reviewProblems(text, profile, RESUME).join(' ')).toMatch(/work authorization/);
  });

  it('refuses when diversity answers disagree', () => {
    const text = GOOD_REVIEW.replace('Gender Female', 'Gender Male');
    expect(reviewProblems(text, profile, RESUME).join(' ')).toMatch(/gender/);
  });

  it('refuses a blank page rather than treating silence as agreement', () => {
    expect(reviewProblems('', profile, RESUME).length).toBeGreaterThan(0);
  });

  it('ignores sections the portal never asked about', () => {
    // No diversity section at all: nothing to disagree with, resume still listed.
    const text = `Will you now or in the future require sponsorship for employment visa status? Yes
      Are you legally authorized to work in the country for which you are applying? Yes
      Yes Yes Nireeksha_AI_Engineer.pdf`;
    expect(reviewProblems(text, profile, RESUME)).toEqual([]);
  });

  it('is not fooled by the answer appearing far away from its question', () => {
    const text = `Gender ${'filler '.repeat(60)} Female
      Yes Yes Nireeksha_AI_Engineer.pdf`;
    expect(reviewProblems(text, profile, RESUME).join(' ')).toMatch(/gender/);
  });
});

describe('identifyStep', () => {
  it('reads each step from its document title', () => {
    expect(identifyStep('Login', '')).toBe('login');
    expect(identifyStep('Personal Information', '')).toBe('personal');
    expect(identifyStep('Diversity - Part 1', '')).toBe('diversity');
    expect(identifyStep('File Attachments', '')).toBe('attachments');
    expect(identifyStep('Review and Submit', '')).toBe('review');
    expect(identifyStep('Thank You', '')).toBe('thankyou');
  });

  it('recognises the confirmation by its text even under another title', () => {
    expect(identifyStep('My Jobpage', 'Process completed Thank You')).toBe('thankyou');
  });

  it('falls back to page content when the title is generic', () => {
    expect(identifyStep('My Jobpage', 'How did you hear about us?')).toBe('personal');
    expect(identifyStep('', 'Please attach your resume to your application')).toBe('attachments');
    expect(identifyStep('', 'Veterans Invitation to Self Identify')).toBe('diversity');
    expect(
      identifyStep('', 'The following information will be submitted after you click the Submit button.'),
    ).toBe('review');
  });

  it('reports an unfamiliar page rather than guessing', () => {
    expect(identifyStep('Error 500', 'something went wrong')).toBe('unknown');
  });
});

describe('answers that a substring check would confuse', () => {
  it('does not accept "Female" as the answer "Male"', () => {
    const text = `Gender Female
      Yes Yes Nireeksha_AI_Engineer.pdf`;
    const problems = reviewProblems(text, { ...profile, gender: 'Male' }, RESUME);
    expect(problems.join(' ')).toMatch(/gender/);
  });

  it('does not accept "Not a Protected Veteran" as "Protected Veteran"', () => {
    const text = `Veterans Invitation to Self Identify Not a Protected Veteran
      Yes Yes Nireeksha_AI_Engineer.pdf`;
    const problems = reviewProblems(
      text,
      { ...profile, veteranStatus: 'Protected Veteran' },
      RESUME,
    );
    expect(problems.join(' ')).toMatch(/veteran/);
  });

  it('still accepts the exact answer', () => {
    const text = `Veterans Invitation to Self Identify Not a Protected Veteran
      Gender Female
      Yes Yes Nireeksha_AI_Engineer.pdf`;
    expect(reviewProblems(text, profile, RESUME)).toEqual([]);
  });

  it('does not read the next question’s answer as this one’s', () => {
    // "Gender" has no value of its own here; "Female" belongs to a later line.
    const text = `Gender Veterans Invitation to Self Identify Not a Protected Veteran Female
      Yes Yes Nireeksha_AI_Engineer.pdf`;
    expect(reviewProblems(text, profile, RESUME).join(' ')).toMatch(/gender/);
  });
});

describe('the privacy agreement step', () => {
  it('is recognised by its title', () => {
    expect(identifyStep('Privacy Agreement', '')).toBe('privacy');
  });

  it('is recognised by its text when the title is generic', () => {
    expect(
      identifyStep(
        'My Jobpage',
        'Before sending your application to Dassault Systemes Talent acquisition Team, ' +
          'please accept or decline our Privacy Agreement.',
      ),
    ).toBe('privacy');
  });
});

describe('the requisition guard', () => {
  const BANNER =
    'Applying for: Staff Cloud Platform Engineer (Job Number: 550383) ' +
    'PERSONAL INFORMATION DIVERSITY - PART 1 FILE ATTACHMENTS REVIEW AND SUBMIT';

  it('reads the job number off the banner', () => {
    expect(statedJobNumber(BANNER)).toBe('550383');
  });

  it('raises no objection when the number matches', () => {
    expect(wrongJobNumber(BANNER, '550383')).toBeNull();
  });

  it('catches an application for a different requisition', () => {
    // A resumed draft for another job would otherwise be submitted silently.
    expect(wrongJobNumber(BANNER, '550021')).toBe('550383');
  });

  it('raises no objection when the page states no number', () => {
    expect(wrongJobNumber('Privacy Agreement I ACCEPT I DECLINE', '550383')).toBeNull();
    expect(statedJobNumber('')).toBeNull();
  });

  it('is not fooled by other numbers on the page', () => {
    expect(statedJobNumber('Posted on: 10/12/26 Job Number: 550029 Date 10/8/26')).toBe('550029');
  });
});
