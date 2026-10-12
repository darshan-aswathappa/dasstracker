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
import type {
  Job,
  StoredJob,
  ScanResult,
  TrackerConfig,
  Application,
  ApplicationStatus,
} from './types.js';

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
        notified_at   TEXT,
        experience    TEXT NOT NULL DEFAULT '',
        entry_level   INTEGER,
        classified_at TEXT
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

      CREATE TABLE IF NOT EXISTS applications (
        card_id      TEXT PRIMARY KEY,
        status       TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 1,
        attempted_at TEXT NOT NULL,
        submitted_at TEXT,
        reason       TEXT,
        screenshot   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at DESC);
    `);
    this.addMissingJobColumns();
  }

  /**
   * Bring a jobs table created before experience tracking up to date.
   * CREATE TABLE IF NOT EXISTS leaves an existing table alone, so columns added
   * later have to be ALTERed in. Done by inspection rather than by catching an
   * error, so a genuine failure still surfaces.
   */
  private addMissingJobColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    const additions: Array<[string, string]> = [
      ['experience', "TEXT NOT NULL DEFAULT ''"],
      ['entry_level', 'INTEGER'],
      ['classified_at', 'TEXT'],
    ];
    for (const [name, decl] of additions) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${decl}`);
      }
    }
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
            posted_at, first_seen_at, matched, notified_at, experience)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
        job.experience ?? '',
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

  // --- Entry-level classification ---

  /**
   * Jobs waiting on a verdict: they state an experience band and have never
   * been asked about. Jobs without a band are left out — there is nothing for
   * the model to read, so asking would only cost a call.
   */
  jobsNeedingClassification(limit = 500): StoredJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE classified_at IS NULL AND experience <> ''
         ORDER BY first_seen_at DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map(rowToJob);
  }

  /** Jobs with no experience band yet, oldest first — backfill candidates. */
  jobsMissingExperience(limit = 1000): StoredJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE experience = '' ORDER BY first_seen_at DESC LIMIT ?`)
      .all(limit);
    return rows.map(rowToJob);
  }

  /**
   * Record a verdict. `entryLevel` is tri-state: true (0-3 years), false
   * (more), or null (Jev could not decide). `classifiedAt` is set either way,
   * so an undecided job is not asked about again on every scan.
   */
  setClassification(cardId: string, entryLevel: boolean | null, classifiedAt: string): void {
    this.db
      .prepare('UPDATE jobs SET entry_level = ?, classified_at = ? WHERE card_id = ?')
      .run(entryLevel === null ? null : entryLevel ? 1 : 0, classifiedAt, cardId);
  }

  /** Attach an experience band to a job stored before the field existed. */
  setExperience(cardId: string, experience: string): void {
    this.db.prepare('UPDATE jobs SET experience = ? WHERE card_id = ?').run(experience, cardId);
  }

  /** Count of jobs per verdict, for status reporting. */
  classificationCounts(): { entry: number; senior: number; undecided: number; pending: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN entry_level = 1 THEN 1 ELSE 0 END) AS entry,
           SUM(CASE WHEN entry_level = 0 THEN 1 ELSE 0 END) AS senior,
           SUM(CASE WHEN classified_at IS NOT NULL AND entry_level IS NULL THEN 1 ELSE 0 END)
             AS undecided,
           SUM(CASE WHEN classified_at IS NULL THEN 1 ELSE 0 END) AS pending
         FROM jobs`,
      )
      .get() as Record<string, number | null>;
    return {
      entry: row.entry ?? 0,
      senior: row.senior ?? 0,
      undecided: row.undecided ?? 0,
      pending: row.pending ?? 0,
    };
  }

  // --- Auto-apply bookkeeping ---

  /**
   * Entry-level matched jobs that are eligible for an auto-apply attempt.
   *
   * `since` excludes everything first seen before auto-apply was armed, so
   * switching the feature on does not fire a burst of applications at the
   * backlog. A job that failed is retried up to `maxAttempts`; one that was
   * submitted is never touched again.
   */
  jobsToAutoApply(since: string, maxAttempts = 3, limit = 10): StoredJob[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j
         LEFT JOIN applications a ON a.card_id = j.card_id
         WHERE j.entry_level = 1
           AND j.matched = 1
           AND j.first_seen_at >= ?
           AND (a.card_id IS NULL OR (a.status = 'failed' AND a.attempts < ?))
         ORDER BY j.first_seen_at ASC
         LIMIT ?`,
      )
      .all(since, maxAttempts, limit);
    return rows.map(rowToJob);
  }

  /** True once a job has been successfully submitted. */
  hasApplied(cardId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM applications WHERE card_id = ? AND status = 'submitted'`)
      .get(cardId);
    return row !== undefined;
  }

  applicationFor(cardId: string): Application | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE card_id = ?').get(cardId);
    return row ? rowToApplication(row) : null;
  }

  /** Record an attempt, incrementing the attempt counter on a retry. */
  recordApplication(app: Omit<Application, 'attempts'>): void {
    this.db
      .prepare(
        `INSERT INTO applications
           (card_id, status, attempts, attempted_at, submitted_at, reason, screenshot)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET
           status       = excluded.status,
           attempts     = applications.attempts + 1,
           attempted_at = excluded.attempted_at,
           submitted_at = excluded.submitted_at,
           reason       = excluded.reason,
           screenshot   = excluded.screenshot`,
      )
      .run(
        app.cardId,
        app.status,
        app.attemptedAt,
        app.submittedAt,
        app.reason,
        app.screenshot,
      );
  }

  recentApplications(limit = 50): Application[] {
    const rows = this.db
      .prepare('SELECT * FROM applications ORDER BY attempted_at DESC LIMIT ?')
      .all(limit);
    return rows.map(rowToApplication);
  }

  countApplications(status: ApplicationStatus): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM applications WHERE status = ?')
      .get(status) as { n: number };
    return row.n;
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
    } catch (err) {
      console.warn(
        `[store] Ignoring malformed config in settings; falling back to defaults: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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

function rowToApplication(row: unknown): Application {
  const r = row as Record<string, unknown>;
  return {
    cardId: r.card_id as string,
    status: r.status as ApplicationStatus,
    attempts: (r.attempts as number) ?? 1,
    attemptedAt: r.attempted_at as string,
    submittedAt: (r.submitted_at as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    screenshot: (r.screenshot as string | null) ?? null,
  };
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
    experience: (r.experience as string) ?? '',
    postedAt: (r.posted_at as string) ?? '',
    firstSeenAt: r.first_seen_at as string,
    matched: (r.matched as number) === 1,
    notifiedAt: (r.notified_at as string | null) ?? null,
    entryLevel: r.entry_level == null ? null : (r.entry_level as number) === 1,
    classifiedAt: (r.classified_at as string | null) ?? null,
  };
}
