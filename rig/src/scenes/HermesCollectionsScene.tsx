/**
 * `hermes.collections` scene (ticket T05, PLAN.md §4 Group 2 / H3):
 * "map/filter/reduce over 100k objects." One sample = one full
 * map->filter->reduce pass over a deterministic 100k-object array,
 * timed with performance.now(). >=30 samples.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt, randRange } from '../harness/seededRandom';
import { median, p95, p99, cv } from '../harness/stats';

const DEFAULT_SAMPLES = 30;
const OBJECT_COUNT = 100_000;

type Item = {
  id: number;
  value: number;
  weight: number;
  category: number;
  active: boolean;
};

/** Deterministic 100k-object array (ticket: seeded, no fixtures). */
function buildItems(seed: number, count: number): Item[] {
  const rand = mulberry32(seed);
  const items: Item[] = new Array(count);
  for (let i = 0; i < count; i++) {
    items[i] = {
      id: i,
      value: randRange(rand, 0, 1000),
      weight: randRange(rand, 0.1, 5),
      category: randInt(rand, 0, 9),
      active: rand() > 0.4,
    };
  }
  return items;
}

/** One map -> filter -> reduce pass. Returns a scalar so the result can't be trivially elided. */
function runPass(items: Item[]): number {
  return items
    .map((item) => ({ ...item, weighted: item.value * item.weight }))
    .filter((item) => item.active && item.category % 2 === 0)
    .reduce((acc, item) => acc + item.weighted, 0);
}

export function HermesCollectionsScene({ params, finish }: SceneProps) {
  useEffect(() => {
    const sampleCount = parseIntParam(params.samples, DEFAULT_SAMPLES);
    const seed = parseIntParam(params.seed, DEFAULT_SEED);

    const items = buildItems(seed, OBJECT_COUNT);

    const samples: number[] = [];
    let checksum = 0;
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      checksum += runPass(items);
      samples.push(performance.now() - start);
    }

    finish({
      unit: 'ms_per_op',
      n: samples.length,
      samples_ms: samples,
      median: median(samples),
      p95: p95(samples),
      p99: p99(samples),
      cv: cv(samples),
      opsPerSec: median(samples) > 0 ? 1000 / median(samples) : 0,
      objectCount: OBJECT_COUNT,
      checksum,
      seed,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>hermes.collections</Text>
      <Text style={styles.subtext}>map/filter/reduce over 100k objects...</Text>
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
