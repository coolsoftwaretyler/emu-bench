/**
 * `sqlite.reads` scene (ticket T05, PLAN.md §4 Group 5): "Indexed point
 * reads after seeding." Seeds 10k rows in a single transaction (seeding
 * cost excluded from the measured samples -- this scene measures reads,
 * not the seed insert), then performs 10k point reads by primary key (the
 * `items` table's `id INTEGER PRIMARY KEY` is SQLite's rowid alias, so
 * this is an indexed lookup with no separate index needed), each timed
 * individually with performance.now(). Reads are shuffled (not sequential
 * by id) so the pattern isn't trivially cache-friendly in row order.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt } from '../harness/seededRandom';
import { buildSeededRows, openFreshDb, setWalMode, SEED_ROW_COUNT } from '../harness/sqliteScene';
import { median, p95, p99, cv } from '../harness/stats';

/** Deterministic Fisher-Yates shuffle of [1..count], driven by the same seeded PRNG. */
function shuffledIds(rand: () => number, count: number): number[] {
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = randInt(rand, 0, i);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

export function SqliteReadsScene({ params, finish }: SceneProps) {
  useEffect(() => {
    const rowCount = parseIntParam(params.rows, SEED_ROW_COUNT);
    const seed = parseIntParam(params.seed, DEFAULT_SEED);

    const db = openFreshDb('embench_reads.db');
    setWalMode(db, false);

    // Seed synchronously in one pass -- not measured (this scene's samples
    // are reads only).
    const rows = buildSeededRows(seed, rowCount);
    db.transaction(async (tx) => {
      for (const row of rows) {
        await tx.execute('INSERT INTO items (id, value, score) VALUES (?, ?, ?)', [
          row.id,
          row.value,
          row.score,
        ]);
      }
    }).then(() => {
      const rand = mulberry32(seed ^ 0x1);
      const readOrder = shuffledIds(rand, rowCount);

      const samples: number[] = [];
      let checksum = 0;
      for (const id of readOrder) {
        const start = performance.now();
        const result = db.executeSync('SELECT value, score FROM items WHERE id = ?', [id]);
        samples.push(performance.now() - start);
        checksum += (result.rows[0]?.score as number) ?? 0;
      }

      db.close();

      finish({
        unit: 'ms_per_op',
        n: samples.length,
        samples_ms: samples,
        median: median(samples),
        p95: p95(samples),
        p99: p99(samples),
        cv: cv(samples),
        opsPerSec: median(samples) > 0 ? 1000 / median(samples) : 0,
        rowCount,
        checksum,
        seed,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>sqlite.reads</Text>
      <Text style={styles.subtext}>10k indexed point reads...</Text>
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
