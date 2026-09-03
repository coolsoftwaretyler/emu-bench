/**
 * `demo.framerecorder` scene (ticket T04 acceptance criterion 3): "Frame
 * recorder demo scene reports plausible ~60/120 Hz frame stats on both
 * platforms." Renders a simple continuously-animating view (via
 * requestAnimationFrame-driven state) so there is always a new frame to
 * present, then runs the shared FrameRecorder for `durationMs` and
 * finishes with its stats.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FrameRecorder } from '../harness/frameRecorder';
import { parseDurationMs } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';

const DEFAULT_DURATION_MS = 3000;

export function FrameRecorderDemoScene({ params, finish }: SceneProps) {
  const durationMs = parseDurationMs(params, DEFAULT_DURATION_MS);
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Keep the UI thread busy re-rendering every frame so the recorder has
    // something driving continuous frame callbacks (not strictly required
    // for requestAnimationFrame to fire, but keeps this scene visually
    // honest about what it's measuring).
    const animate = () => {
      setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);

    const recorder = new FrameRecorder(durationMs);
    recorder.start().then((stats) => {
      finish(stats);
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      recorder.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs]);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>demo.framerecorder</Text>
      <Text style={styles.subtext}>frame {tick}</Text>
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
