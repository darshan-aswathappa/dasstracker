/**
 * SQLite persistence for jobs, scan history, and user settings.
 *
 * Dedup is keyed on `card_id` (the 3DS job id): inserts are idempotent, so a
 * job seen across many scans is stored once. `notified_at` records whether a
 * matched job has already triggered an email, guaranteeing no duplicate
 * notifications.
 */

import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Job, StoredJob, ScanResult, TrackerConfig } from './types.js';

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        card_id       TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        url           TEXT,
        apply_url     TEXT,
        location      TEXT,
        category      TEXT,
        products      TEXT,
        posted_at     TEXT,
        first_seen_at TEXT NOT NULL,
        matched       INTEGER NOT NULL DEFAULT 0,
        notified_at   TEXT
      );

      CREATE TABLE IF NOT EXISTS scans (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at     TEXT NOT NULL,
        fetched        INTEGER NOT NULL,
        new_count      INTEGER NOT NULL,
        matched_count  INTEGER NOT NULL,
        notified_count INTEGER NOT NULL,
        error          TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at DESC);
    `);
  }

  /** True if a job with this card_id already exists. */
  hasJob(cardId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM jobs WHERE card_id = ?').get(cardId);
    return row !== undefined;
  }

  /** Return the set of already-known card_ids from a candidate list. */
  knownIds(cardIds: string[]): Set<string> {
    const known = new Set<string>();
    if (cardIds.length === 0) return known;
    const placeholders = cardIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT card_id FROM jobs WHERE card_id IN (${placeholders})`)
      .all(...cardIds) as Array<{ card_id: string }>;
    for (const r of rows) known.add(r.card_id);
    return known;
  }

  /**
   * Insert a new job. Idempotent: if the card_id already exists, nothing
   * changes and false is returned. Returns true when a new row was inserted.
   */
  insertJob(job: Job, matched: boolean, firstSeenAt: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs
           (card_id, title, url, apply_url, location, category, products,
            posted_at, first_seen_at, matched, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        job.cardId,
        job.title,
        job.url,
        job.applyUrl,
        job.location,
        job.category,
        job.products,
        job.postedAt,
        firstSeenAt,
        matched ? 1 : 0,
      );
    return result.changes > 0;
  }

  /** Matched jobs that have not yet been notified. */
  unnotifiedMatched(): StoredJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE matched = 1 AND notified_at IS NULL
         ORDER BY posted_at DESC`,
      )
      .all();
    return rows.map(rowToJob);
  }

  /** Mark the given card_ids as notified at the given ISO timestamp. */
  markNotified(cardIds: string[], notifiedAt: string): void {
    if (cardIds.length === 0) return;
    const stmt = this.db.prepare('UPDATE jobs SET notified_at = ? WHERE card_id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(notifiedAt, id);
    });
    tx(cardIds);
  }

  /** Recent jobs (matched first when `onlyMatched`), newest first. */
  recentJobs(limit = 100, onlyMatched = false): StoredJob[] {
    const where = onlyMatched ? 'WHERE matched = 1' : '';
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY first_seen_at DESC LIMIT ?`)
      .all(limit);
    return rows.map(rowToJob);
  }

  countJobs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
    return row.n;
  }

  /** Persist a scan record. */
  recordScan(scan: ScanResult): void {
    this.db
      .prepare(
        `INSERT INTO scans
           (started_at, fetched, new_count, matched_count, notified_count, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scan.startedAt,
        scan.fetched,
        scan.newCount,
        scan.matchedCount,
        scan.notifiedCount,
        scan.error,
      );
  }

  recentScans(limit = 20): ScanResult[] {
    const rows = this.db
      .prepare('SELECT * FROM scans ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      startedAt: r.started_at as string,
      fetched: r.fetched as number,
      newCount: r.new_count as number,
      matchedCount: r.matched_count as number,
      notifiedCount: r.notified_count as number,
      error: (r.error as string | null) ?? null,
    }));
  }

  lastScan(): ScanResult | null {
    return this.recentScans(1)[0] ?? null;
  }

  // --- Settings (UI-editable config; secrets stay in env) ---

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Load config from settings, falling back to provided defaults per-field. */
  loadConfig(defaults: TrackerConfig): TrackerConfig {
    const raw = this.getSetting('config');
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw) as Partial<TrackerConfig>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  saveConfig(config: TrackerConfig): void {
    this.setSetting('config', JSON.stringify(config));
  }

  close(): void {
    this.db.close();
  }
}

function rowToJob(row: unknown): StoredJob {
  const r = row as Record<string, unknown>;
  return {
    cardId: r.card_id as string,
    title: r.title as string,
    url: (r.url as string) ?? '',
    applyUrl: (r.apply_url as string) ?? '',
    location: (r.location as string) ?? '',
    category: (r.category as string) ?? '',
    products: (r.products as string) ?? '',
    postedAt: (r.posted_at as string) ?? '',
    firstSeenAt: r.first_seen_at as string,
    matched: (r.matched as number) === 1,
    notifiedAt: (r.notified_at as string | null) ?? null,
  };
}
