/**
 * `skia.s3.texture_churn` (ticket T06, PLAN.md §4 Group 3 / H4): "cycle
 * through 200 generated images (seeded noise, created at scene start -- no
 * bundled assets) forcing continual uploads." A grid of image cells each
 * swaps to a new source image every frame -- react-native-skia has to
 * re-upload a fresh CPU-backed `SkImage` to the GPU as a texture on every
 * swap, so this scene isolates the buffer-upload/copy path (PLAN.md §4:
 * "constant fresh texture uploads" / "zero-copy vs staged copies") rather
 * than command count (S1) or raw fill (S2).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Canvas, Group, Image } from '@shopify/react-native-skia';
import { FrameRecorder } from '../harness/frameRecorder';
import { parseDurationMs, parseWarmupMs, parseNumberParam } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED } from '../harness/seededRandom';
import { generateNoiseImages } from '../harness/generatedImages';

const DEFAULT_DURATION_MS = 8000;
const DEFAULT_WARMUP_MS = 1000;
/** 200 per the ticket's literal scope line. */
const IMAGE_COUNT = 200;
const IMAGE_SIZE_PX = 96;
const GRID_COLUMNS = 4;
const GRID_ROWS = 4;
/** Cells in the grid; each cycles independently so the whole grid isn't
 * swapping in lockstep (closer to a real churn-y feed than a single
 * synchronized flip). */
const CELL_COUNT = GRID_COLUMNS * GRID_ROWS;

export function SkiaS3TextureChurnScene({ params, finish }: SceneProps) {
  const durationMs = parseDurationMs(params, DEFAULT_DURATION_MS);
  const warmupMs = parseWarmupMs(params, DEFAULT_WARMUP_MS);
  const seed = parseNumberParam(params, 'seed', DEFAULT_SEED);
  const imageCount = parseNumberParam(params, 'imageCount', IMAGE_COUNT);
  const { width, height } = useWindowDimensions();

  const images = useMemo(
    () => generateNoiseImages(imageCount, IMAGE_SIZE_PX, seed).filter((img) => img !== null),
    [imageCount, seed],
  );

  const [frameIndex, setFrameIndex] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Offscreen surface allocation failed for every image (see
    // generatedImages.ts doc) -- nothing to churn. Finish immediately with
    // an empty/zeroed measurement rather than running a recorder over a
    // blank canvas that can never demonstrate the upload path.
    if (images.length === 0) {
      finish({
        samples_ms: [],
        median: 0,
        p95: 0,
        p99: 0,
        droppedPct: 0,
        overBudgetPct: 0,
        longestStallMs: 0,
        detectedFrameBudgetMs: 0,
        imageCount: 0,
        seed,
        error: 'no images generated',
      });
      return;
    }

    const animate = () => {
      // Advancing once per rendered frame (not time-based) is deliberate:
      // this scene's whole point is "a fresh texture every frame", so the
      // swap cadence should track frames actually presented, not wall
      // clock -- on a device that's dropping frames, we still want every
      // *presented* frame to carry a fresh upload rather than skipping
      // swaps to stay in sync with time.
      setFrameIndex((f) => f + 1);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);

    const recorder = new FrameRecorder(durationMs, warmupMs);
    recorder.start().then((stats) => {
      finish({ ...stats, imageCount: images.length, seed });
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      recorder.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, warmupMs, images.length, seed]);

  if (images.length === 0) {
    return (
      <View style={styles.container}>
        <Canvas style={StyleSheet.absoluteFill} />
      </View>
    );
  }

  const cellW = width / GRID_COLUMNS;
  const cellH = height / GRID_ROWS;

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Group>
          {Array.from({ length: CELL_COUNT }, (_, cell) => {
            const col = cell % GRID_COLUMNS;
            const row = Math.floor(cell / GRID_COLUMNS);
            // Each cell offset in the cycle so all 16 cells aren't
            // swapping to the identical image simultaneously.
            const img = images[(frameIndex + cell * 13) % images.length]!;
            return (
              <Image
                key={cell}
                image={img}
                x={col * cellW}
                y={row * cellH}
                width={cellW}
                height={cellH}
                fit="cover"
              />
            );
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
