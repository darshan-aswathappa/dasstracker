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

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Radio answers the portal offers for the two eligibility questions. */
export type YesNo = 'Yes' | 'No' | 'Not Specified';

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
  /** Exact file name, as listed on the account's File Attachments step. */
  resumeFileName: string;
}

const YES_NO: readonly string[] = ['Yes', 'No', 'Not Specified'];

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
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
    resumeFileName: requireString(raw, 'resumeFileName'),
  };
}

/** Load the profile shipped in config/application-profile.json. */
export function loadApplicationProfile(
  path = resolve(__dirname, '../../config/application-profile.json'),
): ApplicationProfile {
  return parseApplicationProfile(JSON.parse(readFileSync(path, 'utf8')));
}
