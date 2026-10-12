/**
 * Checking a filled-in application against the profile before submitting it.
 *
 * The portal carries a candidate's previous answers forward and jumps to
 * whatever step still needs input, so the flow often reaches Review with
 * everything already filled by someone other than us. That makes the review
 * page — which lists every answer as text — the one place worth validating:
 * it is what will actually be submitted, whoever filled it in.
 */

import type { ApplicationProfile } from './profile.js';

/** Collapse whitespace so page text can be matched reliably. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the review state `expected` as the answer to `label`?
 *
 * The value must follow the label directly. A looser "appears somewhere
 * nearby" test reads the answer to the *next* question as if it belonged to
 * this one, and worse, substring matching makes "Male" match "Female" and
 * "Protected Veteran" match "Not a Protected Veteran" — both of which would
 * wave through a review that says the opposite of the profile.
 */
function statesThat(text: string, label: RegExp, expected: string): boolean {
  const match = text.match(label);
  if (match?.index === undefined) return false;
  const after = text.slice(match.index + match[0].length);
  // Allow only separators between the label and its value, and require the
  // value to end on a word boundary so a longer answer cannot satisfy it.
  return new RegExp(`^[\\s:|·-]*${escapeRegExp(expected)}(?!\\w)`, 'i').test(after);
}

/** True when the review mentions the label at all. */
function mentions(text: string, label: RegExp): boolean {
  return label.test(text);
}

/**
 * Problems that must stop a submission. An empty array means the review
 * matches the profile and is safe to submit.
 *
 * Answers the page does not show are not treated as problems: the portal omits
 * sections it never asked about. Answers it does show must match — a review
 * that states something other than the profile is the case worth refusing.
 */
export function reviewProblems(pageText: string, profile: ApplicationProfile): string[] {
  const text = flatten(pageText);
  const problems: string[] = [];

  // The resume is the one thing that must be positively confirmed: submitting
  // with the wrong document attached is the costliest mistake available here.
  if (!text.includes(profile.resumeFileName)) {
    problems.push(`review does not list the resume ${profile.resumeFileName}`);
  }

  const checks: Array<{ label: RegExp; expected: string; what: string }> = [
    {
      label: /require sponsorship for employment visa status\??/i,
      expected: profile.requiresSponsorship,
      what: 'visa sponsorship',
    },
    {
      label: /legally authorized to work in the country for which you are applying\??/i,
      expected: profile.legallyAuthorized,
      what: 'work authorization',
    },
    { label: /\bGender\b/i, expected: profile.gender, what: 'gender' },
    {
      label: /Veterans Invitation to Self Identify/i,
      expected: profile.veteranStatus,
      what: 'veteran status',
    },
    {
      label: /Race \(Please select the ethnic group\(s\) that apply to you\)/i,
      expected: profile.race[0] ?? '',
      what: 'race',
    },
  ];

  for (const { label, expected, what } of checks) {
    if (!expected) continue;
    if (!mentions(text, label)) continue; // the portal never asked
    if (!statesThat(text, label, expected)) {
      problems.push(`review does not state ${what} as "${expected}"`);
    }
  }

  return problems;
}

/** The step a page represents, identified from its title and content. */
export type FlowStep =
  | 'login'
  | 'privacy'
  | 'personal'
  | 'diversity'
  | 'attachments'
  | 'review'
  | 'thankyou'
  | 'unknown';

/**
 * Identify a step from the document title, falling back to page text.
 *
 * Taleo titles each step distinctly ("Personal Information", "Diversity -
 * Part 1", "File Attachments", "Review and Submit", "Thank You"), which is a
 * far steadier signal than any element on the page.
 */
export function identifyStep(title: string, bodyText: string): FlowStep {
  const t = flatten(title).toLowerCase();
  const body = flatten(bodyText).toLowerCase();

  if (/thank you/.test(t) || /process completed/.test(body)) return 'thankyou';
  if (/privacy agreement/.test(t)) return 'privacy';
  if (/review and submit/.test(t)) return 'review';
  if (/file attachments/.test(t)) return 'attachments';
  if (/diversity/.test(t)) return 'diversity';
  if (/personal information/.test(t)) return 'personal';
  if (/login|sign in/.test(t)) return 'login';

  // Titles can be generic mid-redirect; fall back to what the page says.
  if (/please accept or decline our privacy agreement/.test(body)) return 'privacy';
  if (/will be submitted after you click the submit button/.test(body)) return 'review';
  if (/please attach your resume/.test(body)) return 'attachments';
  if (/veterans invitation to self identify/.test(body)) return 'diversity';
  if (/how did you hear about us/.test(body)) return 'personal';
  return 'unknown';
}
