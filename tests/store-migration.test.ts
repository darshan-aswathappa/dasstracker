import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/core/store.js';

/** The jobs table exactly as it stood before experience tracking. */
const OLD_SCHEMA = `
  CREATE TABLE jobs (
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
  );`;

let dir: string | null = null;

function oldDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'dasstracker-mig-'));
  const path = join(dir, 'tracker.db');
  const db = new Database(path);
  db.exec(OLD_SCHEMA);
  db.prepare(
    `INSERT INTO jobs (card_id, title, url, apply_url, location, category, products,
                       posted_at, first_seen_at, matched, notified_at)
     VALUES ('546496', 'Head of Product', 'https://x/1', 'https://a/1', 'US, MA, Waltham',
             'Sales', '', '2026-07-01T00:00:00.000Z', '2026-07-03T01:58:10.943Z', 1,
             '2026-07-03T02:00:00.000Z')`,
  ).run();
  db.close();
  return path;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('migrating a pre-experience database', () => {
  it('adds the new columns without touching existing rows', () => {
    const store = new Store(oldDbPath());
    const [row] = store.recentJobs();
    expect(row.cardId).toBe('546496');
    expect(row.title).toBe('Head of Product');
    expect(row.matched).toBe(true);
    expect(row.notifiedAt).toBe('2026-07-03T02:00:00.000Z');
    // New columns default to "nothing known yet".
    expect(row.experience).toBe('');
    expect(row.entryLevel).toBeNull();
    expect(row.classifiedAt).toBeNull();
    expect(row.description).toBe('');
    expect(row.roleKind).toBeNull();
    expect(row.roleClassifiedAt).toBeNull();
    expect(row.roleAttempts).toBe(0);
    expect(row.roleAlertedAt).toBeNull();
    store.close();
  });

  it('is idempotent: reopening the same database does not fail or duplicate', () => {
    const path = oldDbPath();
    const first = new Store(path);
    first.setExperience('546496', '0 to 3 years');
    first.setClassification('546496', true, '2026-10-12T00:00:00.000Z');
    first.close();

    const second = new Store(path);
    const [row] = second.recentJobs();
    expect(row.experience).toBe('0 to 3 years');
    expect(row.entryLevel).toBe(true);
    expect(second.countJobs()).toBe(1);
    second.close();
  });

  it('leaves the migrated row ready for backfill', () => {
    const store = new Store(oldDbPath());
    expect(store.jobsMissingExperience().map((j) => j.cardId)).toEqual(['546496']);
    expect(store.jobsNeedingClassification()).toHaveLength(0);
    // The row is matched, so the role backfill will pick it up.
    expect(store.jobsNeedingRoleClassification().map((j) => j.cardId)).toEqual(['546496']);
    store.close();
  });

  it('carries a role verdict across a reopen', () => {
    const path = oldDbPath();
    const first = new Store(path);
    first.setDescription('546496', 'Lead the product.');
    first.setRoleClassification('546496', 'other', '2026-10-27T00:00:00.000Z');
    first.close();

    const second = new Store(path);
    const [row] = second.recentJobs();
    expect(row.description).toBe('Lead the product.');
    expect(row.roleKind).toBe('other');
    expect(row.roleAttempts).toBe(1);
    expect(second.jobsNeedingRoleClassification()).toHaveLength(0);
    second.close();
  });
});
