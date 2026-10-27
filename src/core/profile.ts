/**
 * The fixed answers an auto-submitted application carries.
 *
 * Kept in config/application-profile.json rather than in code so the answers
 * can be corrected without a deploy, and validated on load so a typo surfaces
 * at startup instead of halfway through a live application.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { RoleKind } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Radio answers the portal offers for the two eligibility questions. */
export type YesNo = 'Yes' | 'No' | 'Not Specified';

/** One resume per kind of role the bot applies to. */
export interface ResumeSet {
  ai: string;
  software: string;
}

export interface ApplicationProfile {
  /** "How did you hear about us?" */
  hearAboutUs: string;
  /** The follow-up "Source" select that appears once hearAboutUs is chosen. */
  source: string;
  requiresSponsorship: YesNo;
  legallyAuthorized: YesNo;
  /** Leave false to keep the "notify me of matching jobs" box unchecked. */
  jobPostingNotification: boolean;
  gender: string;
  veteranStatus: string;
  /** Race checkboxes to tick; the portal allows more than one. */
  race: string[];
  /**
   * The resumes on the account, by the kind of role they are written for.
   * Names must be exact, as listed on the portal's File Attachments step.
   */
  resumes: ResumeSet;
  /**
   * Whether to accept the portal's Privacy Agreement, which gates the whole
   * application ("if you decline, Dassault Systemes will not be able to
   * process your employment application"). Kept here, rather than assumed in
   * code, so the consent being given on the candidate's behalf is visible.
   */
  acceptPrivacyAgreement: boolean;
  /** Language to select on that page. */
  privacyLanguage: string;
}

const YES_NO: readonly string[] = ['Yes', 'No', 'Not Specified'];

function requireString(
  raw: Record<string, unknown>,
  key: string,
  explicit?: unknown,
): string {
  const value = explicit === undefined ? raw[key] : explicit;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`application profile: "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function requireYesNo(raw: Record<string, unknown>, key: string): YesNo {
  const value = requireString(raw, key);
  if (!YES_NO.includes(value)) {
    throw new Error(`application profile: "${key}" must be one of ${YES_NO.join(', ')}`);
  }
  return value as YesNo;
}

/**
 * Read the two resume file names.
 *
 * Both are required rather than defaulted: a missing name would otherwise
 * surface as the portal refusing to find an attachment halfway through a live
 * application, long after the typo could be corrected cheaply.
 */
export function parseResumes(input: unknown): ResumeSet {
  if (!input || typeof input !== 'object') {
    throw new Error('application profile: "resumes" must be an object with "ai" and "software"');
  }
  const raw = input as Record<string, unknown>;
  return {
    ai: requireString(raw, 'resumes.ai', raw.ai),
    software: requireString(raw, 'resumes.software', raw.software),
  };
}

/**
 * The resume a posting of this kind calls for.
 *
 * `other` has no resume: those postings are never applied to automatically,
 * because choosing between the two would be a guess.
 */
export function resumeFor(profile: ApplicationProfile, role: RoleKind): string | null {
  if (role === 'ai') return profile.resumes.ai;
  if (role === 'software') return profile.resumes.software;
  return null;
}

/** Parse and validate a profile object. Throws with a precise message. */
export function parseApplicationProfile(input: unknown): ApplicationProfile {
  if (!input || typeof input !== 'object') {
    throw new Error('application profile: expected a JSON object');
  }
  const raw = input as Record<string, unknown>;

  const race = raw.race;
  if (!Array.isArray(race) || race.length === 0 || race.some((r) => typeof r !== 'string')) {
    throw new Error('application profile: "race" must be a non-empty array of strings');
  }

  return {
    hearAboutUs: requireString(raw, 'hearAboutUs'),
    source: requireString(raw, 'source'),
    requiresSponsorship: requireYesNo(raw, 'requiresSponsorship'),
    legallyAuthorized: requireYesNo(raw, 'legallyAuthorized'),
    jobPostingNotification: raw.jobPostingNotification === true,
    gender: requireString(raw, 'gender'),
    veteranStatus: requireString(raw, 'veteranStatus'),
    race: (race as string[]).map((r) => r.trim()),
    resumes: parseResumes(raw.resumes),
    acceptPrivacyAgreement: raw.acceptPrivacyAgreement === true,
    privacyLanguage:
      typeof raw.privacyLanguage === 'string' && raw.privacyLanguage.trim()
        ? raw.privacyLanguage.trim()
        : 'English',
  };
}

/** Load the profile shipped in config/application-profile.json. */
export function loadApplicationProfile(
  path = resolve(__dirname, '../../config/application-profile.json'),
): ApplicationProfile {
  return parseApplicationProfile(JSON.parse(readFileSync(path, 'utf8')));
}
