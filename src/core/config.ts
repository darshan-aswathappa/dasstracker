/**
 * Configuration loading. Defaults come from config/defaults.json; user edits
 * are persisted in the SQLite settings table and merged over the defaults.
 * Secrets (Gmail credentials) are never stored here — only in the environment.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { TrackerConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Scan-interval bounds. The scheduler fires on a minute-field cron stepping
 * every N minutes, so the largest interval it can express exactly is 59
 * minutes. Clamping here keeps the persisted/displayed interval identical to
 * what actually runs.
 */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 59;

/** Load the default config shipped in config/defaults.json. */
export function loadDefaults(): TrackerConfig {
  const path = resolve(__dirname, '../../config/defaults.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrackerConfig>;
  return {
    intervalMinutes: raw.intervalMinutes ?? 10,
    country: raw.country ?? 'United States',
    type: raw.type ?? 'Regular',
    lang: raw.lang ?? 'en',
    keywords: raw.keywords ?? [],
    categoryWhitelist: raw.categoryWhitelist ?? [],
    notifyTo: raw.notifyTo ?? null,
  };
}

/** Clamp / sanitize a user-supplied config patch before persisting. */
export function sanitizeConfig(
  patch: Partial<TrackerConfig>,
  current: TrackerConfig,
): TrackerConfig {
  const next: TrackerConfig = { ...current, ...patch };

  // Interval must be a sane positive integer, clamped to the range the
  // scheduler can honor (1..59 min). Values above the max are clamped rather
  // than silently diverging from the running schedule.
  const interval = Number(next.intervalMinutes);
  next.intervalMinutes =
    Number.isFinite(interval) && interval >= MIN_INTERVAL_MINUTES
      ? Math.min(Math.floor(interval), MAX_INTERVAL_MINUTES)
      : current.intervalMinutes;

  next.keywords = Array.isArray(next.keywords)
    ? next.keywords.map((k) => String(k).trim()).filter(Boolean)
    : current.keywords;
  next.categoryWhitelist = Array.isArray(next.categoryWhitelist)
    ? next.categoryWhitelist.map((c) => String(c).trim()).filter(Boolean)
    : current.categoryWhitelist;

  next.country = String(next.country || current.country).trim();
  next.type = String(next.type || current.type).trim();
  next.lang = String(next.lang || current.lang).trim();
  next.notifyTo = next.notifyTo ? String(next.notifyTo).trim() : null;

  return next;
}
