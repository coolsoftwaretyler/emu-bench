/**
 * `hermes.strings` scene (ticket T05, PLAN.md §4 Group 2 / H3): "string
 * building, RegExp, date parsing mix." One sample = one pass mixing all
 * three (concatenation-heavy string building, a handful of RegExp
 * matches/replaces, and Date parsing), timed with performance.now().
 * >=30 samples.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt, randWord } from '../harness/seededRandom';
import { median, p95, p99, cv } from '../harness/stats';

const DEFAULT_SAMPLES = 30;
const STRINGS_PER_PASS = 2000;

const EMAIL_RE = /^[\w.+-]+@([\w-]+\.)+[\w-]{2,}$/;
const WORD_RE = /[a-z]+/g;
const DATE_ISO = '2024-03-15T10:30:00.000Z';

/**
 * One pass of "everyday JS grunt work" (PLAN.md §4 Group 2): builds
 * `STRINGS_PER_PASS` strings via concatenation, runs a RegExp match +
 * replace over each, and parses a date on each iteration. Returns a
 * scalar checksum so the engine can't prove the work is unused.
 */
function runPass(rand: () => number): number {
  let checksum = 0;
  for (let i = 0; i < STRINGS_PER_PASS; i++) {
    // String building: concatenation-heavy, not a single template literal,
    // to exercise repeated string allocation/rope behavior.
    let built = '';
    for (let w = 0; w < 6; w++) {
      built += randWord(rand) + '-';
    }
    built += String(randInt(rand, 0, 999999));

    // RegExp: a match + a global replace per iteration.
    const isEmailLike = EMAIL_RE.test(`${randWord(rand)}@${randWord(rand)}.com`);
    const upper = built.replace(WORD_RE, (m) => m.toUpperCase());

    // Date parsing: parse a fixed ISO string plus an offset-varied one.
    const base = new Date(DATE_ISO);
    const offsetDays = randInt(rand, -365, 365);
    const shifted = new Date(base.getTime() + offsetDays * 86_400_000);

    checksum += upper.length + (isEmailLike ? 1 : 0) + shifted.getUTCFullYear();
  }
  return checksum;
}

export function HermesStringsScene({ params, finish }: SceneProps) {
  useEffect(() => {
    const sampleCount = parseIntParam(params.samples, DEFAULT_SAMPLES);
    const seed = parseIntParam(params.seed, DEFAULT_SEED);
    const rand = mulberry32(seed);

    const samples: number[] = [];
    let checksum = 0;
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      checksum += runPass(rand);
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
      stringsPerPass: STRINGS_PER_PASS,
      checksum,
      seed,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>hermes.strings</Text>
      <Text style={styles.subtext}>string/regexp/date mix...</Text>
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
