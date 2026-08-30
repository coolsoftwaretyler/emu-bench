/**
 * `skia.s4.vector_text` (ticket T06, PLAN.md §4 Group 3 / H4): "dense
 * animated paths + a wall of glyphs." Combines heavy vector-path rendering
 * (many-segment animated `<Path>`s) with a large amount of text (many
 * `<Text>` nodes, each its own glyph run) -- PLAN.md §4: "Skia raster/upload
 * mix." Uses `matchFont` against the platform system font (Skia.FontMgr.
 * System()) rather than a bundled `.ttf`, so this scene needs no new asset
 * file (SPEC.md §9 rig scope: no bundled assets for the churn-style scenes;
 * kept consistent here even though the ticket's S4 line doesn't say it
 * explicitly).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Canvas, Group, Path, Skia, Text, matchFont } from '@shopify/react-native-skia';
import { FrameRecorder } from '../harness/frameRecorder';
import { parseDurationMs, parseWarmupMs, parseNumberParam } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED, mulberry32, randInt, randRange, randSentence } from '../harness/seededRandom';

const DEFAULT_DURATION_MS = 8000;
const DEFAULT_WARMUP_MS = 1000;
/** Animated vector paths, each a multi-segment wavy line -- "dense animated
 * paths" per scope. */
const PATH_COUNT = 60;
const PATH_SEGMENTS = 24;
/** "a wall of glyphs" -- enough text lines to fill the screen with distinct
 * glyph runs, each its own draw command. */
const TEXT_LINE_COUNT = 80;
const FONT_SIZE_PX = 14;

type PathSpec = { points: { x: number; y: number }[]; color: string; strokeWidth: number };
type TextLine = { text: string; x: number; baseY: number; color: string };

function buildPaths(count: number, width: number, height: number, seed: number): PathSpec[] {
  const rand = mulberry32(seed);
  const specs: PathSpec[] = [];
  for (let i = 0; i < count; i++) {
    const points = [];
    const y0 = randRange(rand, 0, height);
    for (let s = 0; s <= PATH_SEGMENTS; s++) {
      points.push({ x: (s / PATH_SEGMENTS) * width, y: y0 + randRange(rand, -20, 20) });
    }
    specs.push({
      points,
      color: `hsl(${randInt(rand, 0, 359)}, 65%, 60%)`,
      strokeWidth: randRange(rand, 1, 3),
    });
  }
  return specs;
}

function buildTextLines(count: number, width: number, height: number, seed: number): TextLine[] {
  // Distinct seed offset from buildPaths' rand stream so the two shapes'
  // randomness don't correlate (both derive from the same scene `seed`
  // param, but via independent mulberry32 streams).
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const lines: TextLine[] = [];
  for (let i = 0; i < count; i++) {
    lines.push({
      text: randSentence(rand, randInt(rand, 4, 9)),
      x: randRange(rand, 0, width * 0.3),
      baseY: (i / count) * height,
      color: `hsl(${randInt(rand, 0, 359)}, 20%, 85%)`,
    });
  }
  return lines;
}

export function SkiaS4VectorTextScene({ params, finish }: SceneProps) {
  const durationMs = parseDurationMs(params, DEFAULT_DURATION_MS);
  const warmupMs = parseWarmupMs(params, DEFAULT_WARMUP_MS);
  const seed = parseNumberParam(params, 'seed', DEFAULT_SEED);
  const pathCount = parseNumberParam(params, 'pathCount', PATH_COUNT);
  const lineCount = parseNumberParam(params, 'lineCount', TEXT_LINE_COUNT);
  const { width, height } = useWindowDimensions();

  const paths = useMemo(() => buildPaths(pathCount, width, height, seed), [pathCount, width, height, seed]);
  const textLines = useMemo(
    () => buildTextLines(lineCount, width, height, seed),
    [lineCount, width, height, seed],
  );
  const font = useMemo(() => matchFont({ fontFamily: 'System', fontSize: FONT_SIZE_PX }), []);

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
      finish({ ...stats, pathCount: paths.length, lineCount: textLines.length, seed });
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      recorder.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, warmupMs, paths.length, textLines.length, seed]);

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Group>
          {paths.map((spec, i) => {
            // Rebuild the path's SkPath fresh each frame with a
            // per-segment vertical wobble driven by `t` -- animated paths,
            // not a static one drawn once (per scope: "dense animated
            // paths").
            const skPath = Skia.Path.Make();
            spec.points.forEach((p, s) => {
              const wobble = Math.sin(t * 2 + i + s * 0.4) * 6;
              const x = p.x;
              const y = p.y + wobble;
              if (s === 0) skPath.moveTo(x, y);
              else skPath.lineTo(x, y);
            });
            return (
              <Path
                key={i}
                path={skPath}
                style="stroke"
                strokeWidth={spec.strokeWidth}
                color={spec.color}
              />
            );
          })}
          {font
            ? textLines.map((line, i) => {
                const y = line.baseY + Math.sin(t * 1.5 + i) * 4;
                return <Text key={i} x={line.x} y={y} text={line.text} font={font} color={line.color} />;
              })
            : null}
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
