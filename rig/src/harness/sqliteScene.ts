/**
 * Shared helpers for the `sqlite.*` scenes (ticket T05, PLAN.md §4 Group 5
 * / H7), built on `@op-engineering/op-sqlite` (the sqlite lib chosen in
 * T04 -- see rig/DEPS.md). Opens a fresh on-disk database per scene run
 * (deleted first if present, so results never include a previous run's
 * rows) in the platform's documents-equivalent directory, matching the
 * plain-file results-writer convention (SPEC.md §9) rather than a
 * temp/cache location.
 */

import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { mulberry32, randInt, randSentence } from './seededRandom';

export const SEED_ROW_COUNT = 10_000;

export type SeededRow = { id: number; value: string; score: number };

/** Deterministic row data for seeding/inserting (ticket: seeded PRNG, no fixtures). */
export function buildSeededRows(seed: number, count: number): SeededRow[] {
  const rand = mulberry32(seed);
  const rows: SeededRow[] = new Array(count);
  for (let i = 0; i < count; i++) {
    rows[i] = {
      id: i + 1,
      value: randSentence(rand, 6),
      score: randInt(rand, 0, 1_000_000),
    };
  }
  return rows;
}

/**
 * Opens a fresh on-disk database named `dbName` (deleting any existing
 * file with that name first), and creates the standard `items` table used
 * by every sqlite.* scene.
 */
export function openFreshDb(dbName: string): DB {
  const db = open({ name: dbName });
  try {
    db.delete();
  } catch {
    // no-op: db.delete() on a just-opened, never-persisted DB is fine to fail
  }
  const fresh = open({ name: dbName });
  fresh.executeSync(
    'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL, score INTEGER NOT NULL)',
  );
  fresh.executeSync('DELETE FROM items');
  return fresh;
}

/** Sets WAL mode on or off via PRAGMA (ticket: `sqlite.wal_toggle`). */
export function setWalMode(db: DB, enabled: boolean): void {
  db.executeSync(`PRAGMA journal_mode = ${enabled ? 'WAL' : 'DELETE'}`);
}
