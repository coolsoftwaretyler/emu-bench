/**
 * `hermes.worklet` scene (ticket T05, PLAN.md §4 Group 2 / H3): "Reanimated
 * worklet executing a fixed computation on the UI thread; measures
 * cross-thread scheduling + UI-thread throughput." Both platforms run
 * Hermes on the UI thread too under Reanimated's worklet runtime, so this
 * probes the JS-thread -> UI-thread dispatch (`runOnUI`) round trip plus
 * the fixed computation's UI-thread execution time, not just plain JS
 * throughput (that's `hermes.collections`/`hermes.strings`).
 *
 * One sample = one call from the JS thread that runs a worklet on the UI
 * thread (a fixed, deterministic numeric computation) and reports back via
 * `runOnJS`; the sample is the JS-thread-to-JS-thread round-trip time,
 * timed with performance.now() on the JS side (SPEC.md §9's shared
 * instrumentation: identical JS mechanism on both platforms).
 */

import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { runOnJS, runOnUI } from 'react-native-reanimated';
import type { SceneProps } from '../harness/sceneHarness';
import { median, p95, p99, cv } from '../harness/stats';

const DEFAULT_SAMPLES = 30;
/** Fixed iteration count for the worklet's computation -- deterministic, not data-dependent. */
const COMPUTE_ITERATIONS = 200_000;

/**
 * Reports one worklet round trip's result back to the JS thread. Defined
 * at module scope (rather than as an inline arrow per call) and passed by
 * reference to `runOnJS` -- the standard Reanimated pattern, called
 * directly from inside the one worklet below rather than via a second
 * worklet-marked helper: an earlier version of this scene chained two
 * worklet functions (one calling the other, which called `runOnJS`) and
 * that shape hit an uncaught native exception in the worklets runtime
 * (Reanimated 4.6.0 / react-native-worklets 0.12.1) during manual
 * testing, aborting the process. Flattening to a single worklet calling
 * `runOnJS` directly -- the shape used in Reanimated's own docs/examples
 * -- resolved it.
 */
let reportResult: ((r: number) => void) | null = null;

function handleWorkletResult(r: number): void {
  reportResult?.(r);
}

/**
 * The fixed computation run on the UI thread, called via `runOnUI`. Pure
 * numeric work (no allocations) so the sample reflects UI-thread compute +
 * the cross-thread call itself, not GC pauses. Reports its result back to
 * the JS thread via `runOnJS(handleWorkletResult)` rather than returning a
 * value (worklets scheduled with `runOnUI` are fire-and-forget from the
 * caller's perspective).
 */
function workletCompute(iterations: number): void {
  'worklet';
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc = (acc + Math.sin(i) * Math.cos(i)) % 1000;
  }
  runOnJS(handleWorkletResult)(acc);
}

export function HermesWorkletScene({ params, finish }: SceneProps) {
  const samplesRef = useRef<number[]>([]);
  const checksumRef = useRef(0);

  useEffect(() => {
    const sampleCount = parseIntParam(params.samples, DEFAULT_SAMPLES);
    let cancelled = false;

    function runOneSample(index: number): void {
      if (cancelled) return;

      const start = performance.now();
      reportResult = (r: number) => {
        reportResult = null;
        const elapsed = performance.now() - start;
        if (cancelled) return;
        checksumRef.current += r;
        samplesRef.current.push(elapsed);

        if (index + 1 < sampleCount) {
          runOneSample(index + 1);
        } else {
          finish({
            unit: 'ms_per_op',
            n: samplesRef.current.length,
            samples_ms: samplesRef.current,
            median: median(samplesRef.current),
            p95: p95(samplesRef.current),
            p99: p99(samplesRef.current),
            cv: cv(samplesRef.current),
            opsPerSec: median(samplesRef.current) > 0 ? 1000 / median(samplesRef.current) : 0,
            computeIterations: COMPUTE_ITERATIONS,
            checksum: checksumRef.current,
          });
        }
      };
      runOnUI(workletCompute)(COMPUTE_ITERATIONS);
    }

    runOneSample(0);

    return () => {
      cancelled = true;
      reportResult = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>hermes.worklet</Text>
      <Text style={styles.subtext}>UI-thread worklet round trips...</Text>
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
