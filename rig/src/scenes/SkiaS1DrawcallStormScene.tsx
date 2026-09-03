/**
 * `skia.s1.drawcall_storm` (ticket T06, PLAN.md §4 Group 3 / H4): "5,000
 * individually-issued small shapes per frame, animated positions
 * (deterministic PRNG seed) so no frame is cacheable." Maximizes the number
 * of distinct Skia draw commands issued per frame -- each shape is its own
 * `<Circle>` node, so react-native-skia's reconciler serializes one command
 * per shape, per frame, across the JS/native (and, on Android, the VM)
 * boundary. Indicts command serialization if slow (PLAN.md §4 Group 3
 * table); should be near parity with S2 if the bottleneck is really raw GPU
 * fill instead.
 *
 * Shape count is tuned per the ticket's acceptance criterion 2 ("S1 draw
 * count ... tuned so leg C sits comfortably under frame budget at p50 while
 * clearly loaded (p50 >= ~6ms)") -- see DRAW_COUNT doc below.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Canvas, Circle, Group } from '@shopify/react-native-skia';
import { FrameRecorder } from '../harness/frameRecorder';
import { parseDurationMs, parseWarmupMs, parseNumberParam } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt, randRange } from '../harness/seededRandom';

const DEFAULT_DURATION_MS = 8000;
const DEFAULT_WARMUP_MS = 1000;
/**
 * Ticket scope literally says "5,000 individually-issued small shapes" --
 * measured on this rig (bench-iphone / iPhone 17 Pro simulator, T06
 * verification), 5,000 shapes drove leg C to a ~94ms median frame time
 * (badly over budget, failing acceptance criterion 2's "leg C sits
 * comfortably under frame budget at p50"). Tuned down instead, per that
 * criterion's explicit instruction to tune the count for headroom.
 *
 * A structural note on what "p50 >= ~6ms" can mean here: the frame
 * recorder measures *presented*-frame intervals via requestAnimationFrame
 * (SPEC.md §9's cross-platform contract), which is vsync-quantized -- the
 * simulator's CADisplayLink presents at a fixed 60Hz regardless of the
 * simulated device model's real-hardware ProMotion ceiling (measured
 * directly: even a trivial draw count reads a flat ~16.67ms interval, never
 * something like 8.3ms). So whenever per-frame render cost fits inside one
 * vsync period, the *interval* reads ~16.67ms regardless of whether the
 * true render cost was 2ms or 16ms -- there is no presented-interval value
 * that reads "6ms" on a 60Hz-locked display; only over-budget (dropped)
 * frames read higher than that. DRAW_COUNT is tuned to the highest value
 * that still holds a flat, non-dropped ~16.67ms p50/p95 on leg C (binary
 * search: 700 clean at 16.67/16.72ms, 900 already degrading to 19.7/20.7ms)
 * -- "comfortably under budget, clearly loaded" in the sense of maximum
 * headroom before frames start dropping, which is the only version of that
 * criterion an interval-based recorder can actually demonstrate. See the
 * ticket's acceptance criterion 2 evidence line for the leg B/C numbers
 * this produced.
 */
const DRAW_COUNT = 700;
const SHAPE_RADIUS_PX = 3;

type Shape = { baseX: number; baseY: number; phase: number; speed: number; radius: number; color: string };

function buildShapes(count: number, width: number, height: number, seed: number): Shape[] {
  const rand = mulberry32(seed);
  const shapes: Shape[] = [];
  for (let i = 0; i < count; i++) {
    shapes.push({
      baseX: randRange(rand, 0, width),
      baseY: randRange(rand, 0, height),
      phase: randRange(rand, 0, Math.PI * 2),
      speed: randRange(rand, 0.5, 2.5),
      radius: randRange(rand, 1, SHAPE_RADIUS_PX),
      color: `hsl(${randInt(rand, 0, 359)}, 70%, 55%)`,
    });
  }
  return shapes;
}

export function SkiaS1DrawcallStormScene({ params, finish }: SceneProps) {
  const durationMs = parseDurationMs(params, DEFAULT_DURATION_MS);
  const warmupMs = parseWarmupMs(params, DEFAULT_WARMUP_MS);
  const seed = parseNumberParam(params, 'seed', DEFAULT_SEED);
  const drawCount = parseNumberParam(params, 'drawCount', DRAW_COUNT);
  const { width, height } = useWindowDimensions();

  const shapes = useMemo(() => buildShapes(drawCount, width, height, seed), [drawCount, width, height, seed]);
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
      finish({ ...stats, drawCount, seed });
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      recorder.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, warmupMs, drawCount, seed]);

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Group>
          {shapes.map((s, i) => {
            // Deterministic per-shape motion driven by wall-clock `t` --
            // every frame moves every shape, so nothing about this frame's
            // command stream is identical to the last (no frame is
            // cacheable, per the ticket's literal scope line).
            const x = s.baseX + Math.sin(t * s.speed + s.phase) * 24;
            const y = s.baseY + Math.cos(t * s.speed + s.phase) * 24;
            return <Circle key={i} cx={x} cy={y} r={s.radius} color={s.color} />;
          })}
        </Group>
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
