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
  postedAt: string; // ISO-8601 string
}

/** A job row as persisted, including tracker bookkeeping fields. */
export interface StoredJob extends Job {
  firstSeenAt: string; // ISO-8601
  matched: boolean;
  notifiedAt: string | null; // ISO-8601 or null
  /** Jev's verdict: true = 0-3 years, false = more, null = undecided. */
  entryLevel: boolean | null;
  /** When Jev last ruled on this job; null means it has never been asked. */
  classifiedAt: string | null; // ISO-8601 or null
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
