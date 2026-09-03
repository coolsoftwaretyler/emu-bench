/**
 * `sqlite.insert_txn` scene (ticket T05, PLAN.md §4 Group 5 / H7): "same
 * 10k rows in one transaction (one fsync for the whole batch)." All 10k
 * inserts run inside a single `db.transaction`, so only the final commit
 * fsyncs -- directly comparable to `sqlite.insert_fsync`'s per-row samples
 * (same row count, same seed, same schema), which is what lets the CLI
 * verify the ticket's >=5x acceptance criterion between the two scenes.
 *
 * Per-row samples here measure each row's `execute` call time *inside* the
 * open transaction (no per-row commit/fsync involved); the scene also
 * reports `totalMs` for the whole batch including the final commit, since
 * that end-to-end number is what the >=5x comparison actually needs.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt, randSentence } from '../harness/seededRandom';
import { openFreshDb, setWalMode, SEED_ROW_COUNT } from '../harness/sqliteScene';
import { median, p95, p99, cv } from '../harness/stats';

export function SqliteInsertTxnScene({ params, finish }: SceneProps) {
  useEffect(() => {
    const rowCount = parseIntParam(params.rows, SEED_ROW_COUNT);
    const seed = parseIntParam(params.seed, DEFAULT_SEED);

    const db = openFreshDb('embench_insert_txn.db');
    setWalMode(db, false); // same journal mode as insert_fsync -- only the txn boundary differs

    const rand = mulberry32(seed);
    const samples: number[] = [];

    const batchStart = performance.now();
    db.transaction(async (tx) => {
      for (let i = 0; i < rowCount; i++) {
        const value = randSentence(rand, 6);
        const score = randInt(rand, 0, 1_000_000);
        const start = performance.now();
        await tx.execute('INSERT INTO items (id, value, score) VALUES (?, ?, ?)', [i + 1, value, score]);
        samples.push(performance.now() - start);
      }
    }).then(() => {
      const totalMs = performance.now() - batchStart; // includes the single final commit/fsync
      const rowCheck = db.executeSync('SELECT COUNT(*) as c FROM items').rows[0]?.c;
      db.close();

      finish({
        unit: 'ms_per_row',
        n: samples.length,
        samples_ms: samples,
        median: median(samples),
        p95: p95(samples),
        p99: p99(samples),
        cv: cv(samples),
        rowsPerSec: totalMs > 0 ? (rowCount / totalMs) * 1000 : 0,
        totalMs,
        rowCount,
        rowsInsertedCheck: rowCheck,
        walMode: false,
        seed,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>sqlite.insert_txn</Text>
      <Text style={styles.subtext}>10k rows, single transaction...</Text>
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
