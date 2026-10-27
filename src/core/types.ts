/**
 * Shared domain types for DassTracker.
 */

/** A single normalized job posting extracted from the 3DS search API. */
export interface Job {
  cardId: string;
  title: string;
  url: string;
  applyUrl: string;
  location: string;
  category: string;
  products: string;
  /** Experience band as 3DS states it, e.g. "0 to 3 years". '' when absent. */
  experience: string;
  /** Posting body as plain text, stripped of the API's HTML. '' when absent. */
  description: string;
  postedAt: string; // ISO-8601 string
}

/**
 * What kind of role a posting is, which is what decides the resume:
 * `ai` and `software` each have one, `other` is applied to by hand.
 */
export type RoleKind = 'ai' | 'software' | 'other';

/** A job row as persisted, including tracker bookkeeping fields. */
export interface StoredJob extends Job {
  firstSeenAt: string; // ISO-8601
  matched: boolean;
  notifiedAt: string | null; // ISO-8601 or null
  /** Jev's verdict: true = 0-3 years, false = more, null = undecided. */
  entryLevel: boolean | null;
  /** When Jev last ruled on this job; null means it has never been asked. */
  classifiedAt: string | null; // ISO-8601 or null
  /** Jev's role verdict; null means undecided or never asked. */
  roleKind: RoleKind | null;
  /** When the role verdict was recorded; null while still undecided. */
  roleClassifiedAt: string | null; // ISO-8601 or null
  /** How many times Jev has been asked about the role without deciding. */
  roleAttempts: number;
  /** When the "apply to this one by hand" email went out; null means never. */
  roleAlertedAt: string | null; // ISO-8601 or null
}

/** User-editable configuration (persisted in the settings table). */
export interface TrackerConfig {
  intervalMinutes: number;
  country: string;
  type: string;
  lang: string;
  keywords: string[];
  categoryWhitelist: string[];
  /** Digest recipients. Empty means "fall back to NOTIFY_TO, then GMAIL_USER". */
  notifyTo: string[];
}

/** Result of a single scan cycle, recorded for the status UI. */
export interface ScanResult {
  startedAt: string;
  fetched: number;
  newCount: number;
  matchedCount: number;
  notifiedCount: number;
  error: string | null;
}

/** Outcome of one auto-apply attempt. */
export type ApplicationStatus =
  | 'in_progress'
  | 'submitted'
  | 'failed'
  | 'dry_run'
  /** Submitted but unconfirmed. Never retried automatically. */
  | 'uncertain';

/** A recorded attempt to apply to a job through the 3DS careers portal. */
export interface Application {
  cardId: string;
  status: ApplicationStatus;
  attempts: number;
  attemptedAt: string; // ISO-8601
  submittedAt: string | null; // ISO-8601, set only on a confirmed Thank You page
  reason: string | null; // failure detail, or the dry-run stopping point
  screenshot: string | null; // path to the last screenshot taken
}
