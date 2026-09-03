/**
 * `sqlite.insert_fsync` scene (ticket T05, PLAN.md §4 Group 5 / H7): "10k
 * single-row inserts, implicit transactions (the fsync-heavy pathological
 * case)." Each insert runs and commits on its own (no wrapping
 * transaction), so SQLite's default (non-WAL) journal mode issues an
 * fsync-class flush per row -- exactly the pathological case PLAN.md §4
 * describes ("the killer operation is fsync ... which SQLite issues on
 * every commit"). One sample = one row's insert time via performance.now().
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt, randSentence } from '../harness/seededRandom';
import { openFreshDb, setWalMode, SEED_ROW_COUNT } from '../harness/sqliteScene';
import { median, p95, p99, cv } from '../harness/stats';

export function SqliteInsertFsyncScene({ params, finish }: SceneProps) {
  useEffect(() => {
    const rowCount = parseIntParam(params.rows, SEED_ROW_COUNT);
    const seed = parseIntParam(params.seed, DEFAULT_SEED);

    const db = openFreshDb('embench_insert_fsync.db');
    // Non-WAL journal mode is the default `openFreshDb` leaves the DB in
    // (SQLite's built-in default is `DELETE` journal mode), which is the
    // fsync-per-commit path this scene targets -- pinned explicitly so a
    // future SQLite/op-sqlite default change can't silently switch this
    // scene onto WAL and understate the pathological case.
    setWalMode(db, false);

    const rand = mulberry32(seed);
    const samples: number[] = [];

    for (let i = 0; i < rowCount; i++) {
      const value = randSentence(rand, 6);
      const score = randInt(rand, 0, 1_000_000);
      const start = performance.now();
      // No wrapping transaction: each `execute` is its own implicit
      // transaction, committing (and fsync'ing) on every call.
      db.executeSync('INSERT INTO items (id, value, score) VALUES (?, ?, ?)', [i + 1, value, score]);
      samples.push(performance.now() - start);
    }

    const rowCheck = db.executeSync('SELECT COUNT(*) as c FROM items').rows[0]?.c;
    db.close();

    const totalMs = samples.reduce((a, b) => a + b, 0);
    finish({
      unit: 'ms_per_row',
      n: samples.length,
      samples_ms: samples,
      median: median(samples),
      p95: p95(samples),
      p99: p99(samples),
      cv: cv(samples),
      rowsPerSec: totalMs > 0 ? (samples.length / totalMs) * 1000 : 0,
      rowCount,
      rowsInsertedCheck: rowCheck,
      walMode: false,
      seed,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>sqlite.insert_fsync</Text>
      <Text style={styles.subtext}>10k single-row inserts, implicit txns...</Text>
    </View>
  );
}

function parseIntParam(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
  text: {
    color: 'white',
    fontSize: 24,
    fontWeight: '700',
  },
  subtext: {
    color: '#aaa',
    fontSize: 14,
    marginTop: 8,
  },
});
