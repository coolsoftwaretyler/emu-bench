/**
 * `demo.noop` scene (SPEC.md §9, ticket T04): the harness smoke-test
 * scene. Waits `durationMs`, does nothing else, then finishes with a
 * trivial measurement. Exercises the full mount -> measure -> write
 * results -> bench-done lifecycle without depending on any real workload
 * (those land in T05/T06/T07).
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { parseDurationMs } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';

const DEFAULT_DURATION_MS = 1000;

export function DemoNoopScene({ params, finish }: SceneProps) {
  const durationMs = parseDurationMs(params, DEFAULT_DURATION_MS);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      finish({ durationMs, elapsedMs: Date.now() - startedAt });
    }, durationMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs]);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>demo.noop</Text>
      <Text style={styles.subtext}>waiting {durationMs}ms...</Text>
    </View>
  );
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
