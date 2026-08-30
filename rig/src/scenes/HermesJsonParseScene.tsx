/**
 * `hermes.json_parse` scene (ticket T05, PLAN.md §4 Group 2 / H3): "parse a
 * deterministic ~5 MB realistic API payload (generate from a seeded PRNG
 * at scene start -- no fixture files) xN." Measures JSON.parse itself with
 * performance.now(), >=30 samples, one parse per sample.
 *
 * The payload is built once at scene start (deterministic given the fixed
 * seed) as a JSON *string* -- generation cost is excluded from the
 * measured loop, since the scene measures parsing, not generation.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt, randRange, randSentence, randWord } from '../harness/seededRandom';
import { median, p95, p99, cv } from '../harness/stats';

const DEFAULT_SAMPLES = 30;
const TARGET_PAYLOAD_BYTES = 5 * 1024 * 1024; // ~5 MB, per ticket

type ApiRecord = {
  id: number;
  uuid: string;
  name: string;
  email: string;
  active: boolean;
  score: number;
  tags: string[];
  bio: string;
  createdAt: string;
  address: {
    street: string;
    city: string;
    zip: string;
    geo: { lat: number; lng: number };
  };
  metadata: Record<string, string | number | boolean>;
};

/**
 * Builds a deterministic ~5 MB "realistic API payload" -- an array of
 * record objects resembling a paginated REST API response, the kind of
 * thing `hermes.json_parse` is meant to simulate ("ingest a big API
 * response", PLAN.md §4). Generation is driven entirely by the seeded
 * PRNG, so the same seed produces byte-identical JSON text on every
 * platform and every run (T05's determinism acceptance criterion).
 */
function buildPayloadJson(seed: number, targetBytes: number): string {
  const rand = mulberry32(seed);
  const records: ApiRecord[] = [];
  let approxBytes = 2; // account for the wrapping [ ] before any records exist

  while (approxBytes < targetBytes) {
    const id = records.length + 1;
    const record: ApiRecord = {
      id,
      uuid: `${id.toString(16).padStart(8, '0')}-${randInt(rand, 1000, 9999)}-${randInt(rand, 1000, 9999)}`,
      name: `${randWord(rand)} ${randWord(rand)}`,
      email: `${randWord(rand)}.${randWord(rand)}@example.com`,
      active: rand() > 0.3,
      score: Math.round(randRange(rand, 0, 100) * 100) / 100,
      tags: Array.from({ length: randInt(rand, 1, 5) }, () => randWord(rand)),
      bio: randSentence(rand, randInt(rand, 8, 24)),
      createdAt: new Date(Date.UTC(2020, 0, 1) + randInt(rand, 0, 1000) * 86_400_000).toISOString(),
      address: {
        street: `${randInt(rand, 1, 9999)} ${randWord(rand)} St`,
        city: randWord(rand),
        zip: String(randInt(rand, 10000, 99999)),
        geo: {
          lat: Math.round(randRange(rand, -90, 90) * 10000) / 10000,
          lng: Math.round(randRange(rand, -180, 180) * 10000) / 10000,
        },
      },
      metadata: {
        source: randWord(rand),
        priority: randInt(rand, 0, 5),
        verified: rand() > 0.5,
      },
    };
    records.push(record);
    // Rough per-record JSON size estimate to avoid re-stringifying the
    // whole growing array every iteration just to check length.
    approxBytes += 420;
  }

  return JSON.stringify({ page: 1, perPage: records.length, total: records.length, records });
}

export function HermesJsonParseScene({ params, finish }: SceneProps) {
  useEffect(() => {
    const sampleCount = parseIntParam(params.samples, DEFAULT_SAMPLES);
    const seed = parseIntParam(params.seed, DEFAULT_SEED);

    const payloadJson = buildPayloadJson(seed, TARGET_PAYLOAD_BYTES);
    const payloadBytes = payloadJson.length;

    const samples: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      const parsed = JSON.parse(payloadJson);
      const elapsed = performance.now() - start;
      samples.push(elapsed);
      // Prevent the JIT/engine from proving the parse result is unused and
      // eliding it -- touch one field so the parse can't be optimized away.
      if (parsed.records.length < 0) samples.push(-1);
    }

    const opsPerSec = median(samples) > 0 ? 1000 / median(samples) : 0;

    finish({
      unit: 'ms_per_op',
      n: samples.length,
      samples_ms: samples,
      median: median(samples),
      p95: p95(samples),
      p99: p99(samples),
      cv: cv(samples),
      opsPerSec,
      payloadBytes,
      seed,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>hermes.json_parse</Text>
      <Text style={styles.subtext}>parsing ~5MB payload x{params.samples ?? DEFAULT_SAMPLES}...</Text>
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
