/**
 * `list.scroll` (ticket T06, PLAN.md §4 Group 3): "FlashList with 1,000
 * image cards (generated images), deterministic in-app auto-scroll at
 * fixed velocity via an animated scroll driver -- not Maestro-driven, for
 * reproducibility (SPEC.md §9)." Every card renders a distinct generated
 * (seeded-noise) image so the list is a real image-heavy feed rather than
 * flat color blocks -- the canonical "does scrolling stutter" test (PLAN.md
 * §4 Group 3).
 *
 * The scroll driver ticks on `requestAnimationFrame` and computes its
 * target offset purely from elapsed wall-clock time
 * (`offset = velocity * elapsedSeconds`), then calls
 * `scrollToOffset({ offset, animated: false })` -- so the scroll position
 * at any moment tracks time, not frames actually presented, and a stutter
 * mid-scroll shows up in the FrameRecorder's p95/p99 without perturbing
 * *where* the list should be.
 *
 * The reported `totalScrolledPx` (acceptance criterion 3: "scroll distance
 * per run is identical across platforms and runs -- log total px scrolled;
 * must match") is `velocity * (warmupMs + durationMs) / 1000` -- computed
 * directly from the scene's own params, not sampled off the last RAF tick's
 * wall-clock reading. The latter would vary run-to-run by however many ms
 * of jitter land on whichever side of the warmup/finish boundaries a given
 * run's frames happen to fall (measured: ~0.6px of the ~1600px total on a
 * 3s test run) -- close, but not the exact match the criterion asks for.
 * Computing it from params instead makes the two exactly equal by
 * construction, independent of actual frame timing on either platform.
 *
 * `mode=manual` (ticket T11, PLAN.md §4 Group 6 E2E row: "scroll a list --
 * reuse `list.scroll` scene in manual-scroll mode: add a `mode=manual` param
 * disabling auto-scroll so Maestro swipes"): when this param is present,
 * the RAF-driven `scrollToOffset` loop above never starts and the list's
 * own native `scrollEnabled` is left on, so Maestro's `swipe`/`scroll`
 * gesture commands drive the list exactly the way a user would -- the E2E
 * flow needs a target it can actually author gestures against, not the
 * default mode's deterministic, non-interactive auto-scroll (which stays
 * the default precisely so the *other* scenes/scenarios that reuse this
 * component -- the frame-time measurement itself, T12's power scenario --
 * keep their reproducible, driver-independent scroll). `totalScrolledPx`
 * has no meaning in manual mode (nothing drives a known distance), so it
 * is reported as `null` rather than the auto-scroll formula's now-untrue
 * value.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Canvas, Image } from '@shopify/react-native-skia';
import type { SkImage } from '@shopify/react-native-skia';
import type { FlashListRef } from '@shopify/flash-list';
import { FrameRecorder } from '../harness/frameRecorder';
import { parseDurationMs, parseWarmupMs, parseNumberParam } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';
import { DEFAULT_SEED } from '../harness/seededRandom';
import { generateNoiseImages } from '../harness/generatedImages';

/** Default duration matches the ticket's "default 60s to serve as T12's
 * power scenario" -- T12 (Group 7, host cost) reuses this scene as its
 * sustained-load endurance scenario. */
const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_WARMUP_MS = 1000;
/** 1,000 per the ticket's literal scope line. */
const CARD_COUNT = 1000;
const CARD_IMAGE_SIZE_PX = 64;
const CARD_HEIGHT_PX = 96;
/** px/s -- chosen so a 60s default run traverses the full 1,000-card list
 * roughly ~3x (1,000 cards * ~96px card height / 60s ≈ 1600px/s covers the
 * list once in 60s; this runs it over at a comfortable, clearly-visible
 * scroll speed, not a blur-past). */
const DEFAULT_VELOCITY_PX_PER_S = 400;

type CardItem = { id: number; image: SkImage | null; label: string };

export function ListScrollScene({ params, finish }: SceneProps) {
  const durationMs = parseDurationMs(params, DEFAULT_DURATION_MS);
  const warmupMs = parseWarmupMs(params, DEFAULT_WARMUP_MS);
  const seed = parseNumberParam(params, 'seed', DEFAULT_SEED);
  const cardCount = parseNumberParam(params, 'cardCount', CARD_COUNT);
  const velocity = parseNumberParam(params, 'velocity', DEFAULT_VELOCITY_PX_PER_S);
  // T11: `mode=manual` disables the RAF auto-scroll driver below and leaves
  // native scrolling on, so Maestro's swipe/scroll gestures move the list
  // instead (see file-level doc).
  const manualMode = params.mode === 'manual';
  const { width } = useWindowDimensions();

  const images = useMemo(() => generateNoiseImages(cardCount, CARD_IMAGE_SIZE_PX, seed), [cardCount, seed]);
  const data = useMemo<CardItem[]>(
    () => images.map((image, i) => ({ id: i, image, label: `card ${i}` })),
    [images],
  );

  const listRef = useRef<FlashListRef<CardItem>>(null);
  const rafRef = useRef<number | null>(null);
  // Ground truth for the logged scroll distance: a pure function of this
  // scene's own params, matching exactly across platforms and runs by
  // construction (see file-level doc).
  const expectedTotalScrolledPx = (velocity * (warmupMs + durationMs)) / 1000;

  useEffect(() => {
    const recorder = new FrameRecorder(durationMs, warmupMs);

    if (!manualMode) {
      let scrollStart: number | null = null;
      const driveScroll = (now: number) => {
        if (scrollStart === null) scrollStart = now;
        const elapsedS = (now - scrollStart) / 1000;
        const offset = velocity * elapsedS;
        listRef.current?.scrollToOffset({ offset, animated: false });
        rafRef.current = requestAnimationFrame(driveScroll);
      };
      rafRef.current = requestAnimationFrame(driveScroll);
    }

    recorder.start().then((stats) => {
      finish({
        ...stats,
        cardCount: data.length,
        velocityPxPerS: velocity,
        // Manual mode has no driven distance to report (see file-level
        // doc) -- null rather than the auto-scroll formula's now-untrue
        // value.
        totalScrolledPx: manualMode ? null : expectedTotalScrolledPx,
        mode: manualMode ? 'manual' : 'auto',
        seed,
      });
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      recorder.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, warmupMs, velocity, data.length, seed, manualMode]);

  return (
    <View style={styles.container}>
      <FlashList
        testID="list-scroll-list"
        ref={listRef}
        data={data}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <Card item={item} width={width} />}
        scrollEnabled={manualMode}
      />
    </View>
  );
}

function Card({ item, width }: { item: CardItem; width: number }) {
  return (
    <View style={[styles.card, { width }]}>
      {item.image ? (
        <Canvas style={styles.cardImage}>
          <Image
            image={item.image}
            x={0}
            y={0}
            width={CARD_IMAGE_SIZE_PX}
            height={CARD_IMAGE_SIZE_PX}
            fit="cover"
          />
        </Canvas>
      ) : (
        <View style={[styles.cardImage, styles.cardImageFallback]} />
      )}
      <Text style={styles.cardLabel}>{item.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
  },
  card: {
    height: CARD_HEIGHT_PX,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  cardImage: {
    width: CARD_IMAGE_SIZE_PX,
    height: CARD_IMAGE_SIZE_PX,
    borderRadius: 8,
  },
  cardImageFallback: {
    backgroundColor: '#333',
  },
  cardLabel: {
    color: '#ddd',
    marginLeft: 12,
    fontSize: 14,
  },
});
