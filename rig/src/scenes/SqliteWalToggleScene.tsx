/**
 * `sqlite.wal_toggle` scene (ticket T05, PLAN.md §4 Group 5): "repeat
 * insert_fsync with WAL on vs off (two sub-results)." Runs the exact same
 * per-row single-insert-implicit-transaction workload as
 * `sqlite.insert_fsync` twice, back to back in one scene run -- once with
 * `journal_mode = DELETE` (WAL off) and once with `journal_mode = WAL`
 * (WAL on) -- against separate fresh databases, and reports both as named
 * sub-results (`walOff`, `walOn`) in one measurement payload.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DB } from '@op-engineering/op-sqlite';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt, randSentence } from '../harness/seededRandom';
import { openFreshDb, setWalMode, SEED_ROW_COUNT } from '../harness/sqliteScene';
import { median, p95, p99, cv } from '../harness/stats';

type SubResult = {
  unit: string;
  n: number;
  samples_ms: number[];
  median: number;
  p95: number;
  p99: number;
  cv: number;
  rowsPerSec: number;
};

/** Runs the insert_fsync-style workload (per-row implicit transactions) against `db`, WAL already set by the caller. */
function runInsertFsyncWorkload(db: DB, rowCount: number, seed: number): SubResult {
  const rand = mulberry32(seed);
  const samples: number[] = [];

  for (let i = 0; i < rowCount; i++) {
    const value = randSentence(rand, 6);
    const score = randInt(rand, 0, 1_000_000);
    const start = performance.now();
    db.executeSync('INSERT INTO items (id, value, score) VALUES (?, ?, ?)', [i + 1, value, score]);
    samples.push(performance.now() - start);
  }

  const totalMs = samples.reduce((a, b) => a + b, 0);
  return {
    unit: 'ms_per_row',
    n: samples.length,
    samples_ms: samples,
    median: median(samples),
    p95: p95(samples),
    p99: p99(samples),
    cv: cv(samples),
    rowsPerSec: totalMs > 0 ? (samples.length / totalMs) * 1000 : 0,
  };
}

export function SqliteWalToggleScene({ params, finish }: SceneProps) {
  useEffect(() => {
    const rowCount = parseIntParam(params.rows, SEED_ROW_COUNT);
    const seed = parseIntParam(params.seed, DEFAULT_SEED);

    const dbOff = openFreshDb('embench_wal_toggle_off.db');
    setWalMode(dbOff, false);
    const walOff = runInsertFsyncWorkload(dbOff, rowCount, seed);
    dbOff.close();

    const dbOn = openFreshDb('embench_wal_toggle_on.db');
    setWalMode(dbOn, true);
    const walOn = runInsertFsyncWorkload(dbOn, rowCount, seed);
    dbOn.close();

    finish({
      rowCount,
      seed,
      walOff,
      walOn,
      // Convenience top-level ratio: how much WAL helps on this leg (>1 means WAL is faster).
      walSpeedupRatio: walOn.median > 0 ? walOff.median / walOn.median : 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>sqlite.wal_toggle</Text>
      <Text style={styles.subtext}>insert_fsync workload, WAL off then on...</Text>
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
