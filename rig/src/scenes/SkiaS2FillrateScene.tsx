/**
 * `skia.s2.fillrate` (ticket T06, PLAN.md §4 Group 3 / H4): "stacked
 * full-screen gradients + blur layers, animated parameters." Few draw
 * commands (opposite of S1's thousands) but each command covers every pixel
 * on screen -- maximal pixel/fill work per command. PLAN.md §4 Group 3:
 * "should be near parity (same physical GPU)" -- if this scene shows a
 * large emulator/simulator gap, the ticket's own verification step calls
 * that out as suspicious (check `-gpu host` is really active).
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Canvas, Fill, LinearGradient, Blur, vec } from '@shopify/react-native-skia';
import { FrameRecorder } from '../harness/frameRecorder';
import { parseDurationMs, parseWarmupMs, parseNumberParam } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';

const DEFAULT_DURATION_MS = 8000;
const DEFAULT_WARMUP_MS = 1000;
/** Full-screen gradient+blur passes stacked per frame -- each one is a
 * whole-screen fill, so this is a pixel-work knob, not a command-count knob
 * (that's S1's job). 6 keeps the scene GPU-bound without needing a device-
 * specific tune (PLAN.md §4 Group 3: S2 "should be near parity" is the
 * point -- unlike S1, this scene isn't trying to sit at a specific p50). */
const LAYER_COUNT = 6;
const BLUR_RADIUS_PX = 18;

const PALETTES: [string, string][] = [
  ['#ff5f6d', '#ffc371'],
  ['#00c6ff', '#0072ff'],
  ['#f7971e', '#ffd200'],
  ['#8e2de2', '#4a00e0'],
  ['#11998e', '#38ef7d'],
  ['#fc4a1a', '#f7b733'],
];

export function SkiaS2FillrateScene({ params, finish }: SceneProps) {
  const durationMs = parseDurationMs(params, DEFAULT_DURATION_MS);
  const warmupMs = parseWarmupMs(params, DEFAULT_WARMUP_MS);
  const layerCount = parseNumberParam(params, 'layerCount', LAYER_COUNT);
  const { width, height } = useWindowDimensions();

  const [t, setT] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = performance.now();
    const animate = () => {
      setT((performance.now() - start) / 1000);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);

    const recorder = new FrameRecorder(durationMs, warmupMs);
    recorder.start().then((stats) => {
      finish({ ...stats, layerCount });
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      recorder.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, warmupMs, layerCount]);

  const layers = Array.from({ length: layerCount }, (_, i) => i);

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        {layers.map((i) => {
          const [c0, c1] = PALETTES[i % PALETTES.length];
          // Animated angle per layer so the gradient direction keeps
          // changing frame to frame (animated parameters, per scope) --
          // this is still one full-screen draw command per layer, just
          // with different shader uniforms each frame, so it stays a pure
          // fill-rate/GPU-blend cost rather than adding command count.
          const angle = t * (0.3 + i * 0.05) + i;
          const start = vec(width / 2 + Math.cos(angle) * width, height / 2 + Math.sin(angle) * height);
          const end = vec(width / 2 - Math.cos(angle) * width, height / 2 - Math.sin(angle) * height);
          return (
            <Fill key={i}>
              <LinearGradient start={start} end={end} colors={[c0, c1]} />
              <Blur blur={BLUR_RADIUS_PX} />
            </Fill>
          );
        })}
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
  },
});
