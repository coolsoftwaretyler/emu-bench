/**
 * `touch.latency` (ticket T07, PLAN.md §4 Group 4, H6): "the rig records
 * each touch event's native timestamp and the time of the next presented
 * frame after the resulting state change commits -- the gap is what a user
 * waits. Identical JS instrumentation both platforms; immune to injection-
 * tool differences." This is the suite's primary input-to-photon metric --
 * measured entirely inside the app, so the tap driver (Maestro, or the
 * `adb shell input tap` fallback) only needs to *deliver* taps, never to
 * deliver them fast; its own latency cancels out of the comparison.
 *
 * Full-screen touchable; each `onPressIn` (touch-down, not touch-up --
 * touch-down is the earliest moment RN's gesture responder system fires,
 * and the moment a user's mental model of "I tapped it" anchors to) flips
 * a stark two-color background (visual feedback the ticket requires as "an
 * obvious high-contrast change" -- T09 reuses this exact flip for
 * pixel-diff detection) and records the delta from the tap's native
 * timestamp to the next `requestAnimationFrame` callback after React has
 * committed that state change and the platform has presented the frame.
 *
 * ## Clock-domain normalization (the ticket's flagged risk)
 *
 * `event.nativeEvent.timestamp` is NOT in the same clock domain as JS's
 * `performance.now()`/`requestAnimationFrame`'s timestamp argument on
 * either platform, and the two platforms don't even agree with each other
 * on what it *is*:
 *
 * - **Android**: traced to RN's `TouchEvent.kt` -- `init()` calls
 *   `super.init(surfaceId, viewTag, motionEventToCopy.eventTime)`, and
 *   `TouchesHelper.kt` writes that same `event.timestampMs` into the JS
 *   payload's `timestamp` field. `MotionEvent.eventTime` is
 *   `SystemClock.uptimeMillis()`: milliseconds since the device booted,
 *   excluding deep-sleep time.
 * - **iOS**: traced to RN's `RCTTouchHandler.m` --
 *   `reactTouch[@"timestamp"] = @(nativeTouch.timestamp * 1000)`.
 *   `UITouch.timestamp` is an `NSTimeInterval` (seconds) anchored to the
 *   system's monotonic uptime clock (mach absolute time), converted to ms
 *   "for JS" right there.
 *
 * Both are monotonic "ms since some boot-relative epoch" clocks -- but
 * neither is documented or guaranteed to share an epoch with RN's
 * `performance.now()` (see `setUpPerformance.js`: backed by a native
 * performance module if present, else `global.nativePerformanceNow ||
 * Date.now`), and this suite must not bake in an assumption about private
 * RN internals that could rot across versions.
 *
 * ### Calibration: running minimum offset, not a single fixed sample
 *
 * A first attempt at this scene calibrated the clock offset from a single
 * tap (`offset = performance.now() - nativeEvent.timestamp`, read back to
 * back in the same `onPressIn` invocation) and reused it for every later
 * tap. Manual verification caught this producing **negative deltas on
 * iOS** (e.g. -7ms, -12ms) -- exactly the failure mode this ticket's Risks
 * section warns about ("If emulator < simulator, suspect timestamp clock
 * domains before celebrating," generalized here to "if a delta is
 * negative, suspect the calibration").
 *
 * The root cause: `onPressIn` doesn't fire the instant the finger touches
 * the glass -- RN's gesture responder system has its own (small, variable)
 * hit-test/negotiation delay before the JS handler runs, and that delay
 * differs tap to tap. A single-tap calibration bakes *that specific tap's*
 * delay into "the offset," and any later tap with a *smaller* delay than
 * the calibration tap then reads as a negative delta once the (too-large)
 * offset is subtracted back out.
 *
 * The fix: model each observed `candidateOffset_i = jsNow_i -
 * nativeTimestamp_i` as `trueOffset + dispatchDelay_i`, where
 * `dispatchDelay_i >= 0` is that tap's own (unknown, variable) responder
 * dispatch delay. Because `dispatchDelay_i` can never be negative,
 * `trueOffset` is a lower bound on every `candidateOffset_i`, approached
 * by whichever tap happened to have the *smallest* dispatch delay -- i.e.
 * **`trueOffset ~= min_i(candidateOffset_i)`**, refined as more taps
 * arrive. Any offset larger than the true minimum systematically inflates
 * every bridged press time, which is exactly what produced the negative
 * deltas above.
 *
 * Concretely: every tap's raw `(nativeTimestampMs, rafPresentedMs)` pair
 * is stored as it resolves, and the running-minimum candidate offset is
 * tracked as taps arrive. Final deltas are computed only once the run
 * finishes (`minSamples` reached), using the *best* (smallest) offset seen
 * across the *entire* run -- so a late tap's smaller offset still
 * corrects every earlier sample's delta, not just samples after it.
 *
 * A tap that never produces a subsequent frame-present callback within
 * `MISS_TIMEOUT_MS` (rare -- e.g. a dropped/coalesced touch event) is
 * counted as a miss, not a sample, per the ticket's acceptance criterion
 * ("taps that miss ... are excluded and counted in the results notes").
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { median, p95, p99, cv } from '../harness/stats';
import { parseNumberParam } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';

/** >=30 per the ticket's literal acceptance criterion. */
const DEFAULT_MIN_SAMPLES = 30;
/**
 * A tap whose next frame-present callback doesn't land within this window
 * is almost certainly a missed/coalesced touch event, not a real (if slow)
 * photon delay -- the ticket's own plausible range tops out at 100ms, so
 * 2000ms gives enormous headroom above any real delta before giving up and
 * counting the tap as a miss rather than waiting forever.
 */
const MISS_TIMEOUT_MS = 2000;

/** The two high-contrast colors the scene alternates between on each tap --
 * "obvious high-contrast change" per the ticket scope, reused verbatim by
 * T09's pixel-diff detector. */
const COLOR_DARK = '#050505';
const COLOR_LIGHT = '#f5f5f5';

/** One resolved tap's raw clock readings, in native-domain ms, before the
 * final offset is known. */
type RawTap = {
  nativeTimestampMs: number;
  rafPresentedMs: number;
  /** This tap's own candidate offset (jsNow at press time minus its
   * nativeTimestampMs) -- used only to refine the running minimum, never
   * reported directly. */
  candidateOffsetMs: number;
};

export function TouchLatencyScene({ params, finish }: SceneProps) {
  const minSamples = parseNumberParam(params, 'minSamples', DEFAULT_MIN_SAMPLES);

  const [flash, setFlash] = useState(false);
  const [tapCount, setTapCount] = useState(0);

  // Running-minimum clock-domain offset (see file doc). Refined across
  // every tap; the FINAL value (once the run ends) is used to recompute
  // every stored raw tap's delta, so a later tap's smaller offset also
  // corrects earlier samples.
  const minCandidateOffsetMsRef = useRef<number | null>(null);

  // Pending tap awaiting its frame-present callback: its native-domain
  // timestamp plus the jsNow read in the same handler invocation (used to
  // update the running-minimum offset once the tap resolves).
  const pendingRef = useRef<{ nativeTimestampMs: number; jsNowAtPressMs: number } | null>(null);
  const missTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  const finishedRef = useRef(false);

  const rawTapsRef = useRef<RawTap[]>([]);
  const missCountRef = useRef(0);

  const finishScene = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (rafHandleRef.current !== null) cancelAnimationFrame(rafHandleRef.current);
    if (missTimerRef.current !== null) clearTimeout(missTimerRef.current);

    // Recompute every sample's delta using the FINAL running-minimum
    // offset (the best estimate of trueOffset available once the whole
    // run is in) -- see file doc: a tap earlier in the run may have had a
    // larger dispatch delay than one seen later, so refining only forward
    // would leave early samples over-corrected.
    const finalOffsetMs = minCandidateOffsetMsRef.current ?? 0;
    const samples = rawTapsRef.current.map(
      (tap) => tap.rafPresentedMs - (tap.nativeTimestampMs + finalOffsetMs),
    );

    const notes =
      missCountRef.current > 0
        ? `${missCountRef.current} tap(s) missed (no frame-present callback within ${MISS_TIMEOUT_MS}ms) and excluded from samples.`
        : 'No missed taps.';

    finish({
      unit: 'ms',
      n: samples.length,
      samples_ms: samples,
      median: median(samples),
      p95: p95(samples),
      p99: p99(samples),
      cv: cv(samples),
      missedTaps: missCountRef.current,
      totalTapsAttempted: samples.length + missCountRef.current,
      clockOffsetMs: finalOffsetMs,
      clockNormalizationMethod:
        'nativeEvent.timestamp (Android: MotionEvent.eventTime/SystemClock.uptimeMillis; ' +
        'iOS: UITouch.timestamp*1000, mach-uptime-derived) bridged into performance.now()/' +
        'requestAnimationFrame domain via a running-minimum offset refined across every tap ' +
        'in the run (offset_i = performance.now() - nativeEvent.timestamp at press time; ' +
        'true offset is upper-bounded by every observed offset_i since each tap\'s own ' +
        'responder-dispatch delay is >=0, so the minimum observed offset_i is the best ' +
        'estimate). Reported as clockOffsetMs. Final per-tap deltas are recomputed once using ' +
        'this run-final offset so a late tap with a smaller true offset also corrects earlier ' +
        'samples. See TouchLatencyScene.tsx file doc for why a single-tap calibration produced ' +
        'negative deltas on iOS during development.',
      notes,
    });
  }, [finish]);

  const maybeFinishIfEnough = useCallback(() => {
    if (rawTapsRef.current.length >= minSamples) {
      finishScene();
    }
  }, [minSamples, finishScene]);

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      if (finishedRef.current) return;
      // A tap arriving while a previous one is still awaiting its
      // frame-present callback would corrupt pairing -- ignore it
      // defensively (Maestro's ~1s tap cadence and the 2s miss timeout
      // make simultaneous-pending taps not the expected steady state).
      if (pendingRef.current !== null) return;

      const nativeTimestampMs = event.nativeEvent.timestamp;
      const jsNowAtPressMs = performance.now();
      pendingRef.current = { nativeTimestampMs, jsNowAtPressMs };

      setFlash((f) => !f);
      setTapCount((c) => c + 1);

      missTimerRef.current = setTimeout(() => {
        if (pendingRef.current === null) return; // already resolved by RAF
        pendingRef.current = null;
        missCountRef.current += 1;
        maybeFinishIfEnough();
      }, MISS_TIMEOUT_MS);
    },
    [maybeFinishIfEnough],
  );

  useEffect(() => {
    // One continuously-running RAF loop for the scene's whole lifetime.
    // Each callback's `rafNowMs` argument is, by RN's contract, the
    // timestamp of the frame just presented -- if a tap is pending when
    // this fires, that presented frame is the first one after the tap's
    // state commit landed (React commits synchronously inside the touch
    // handler's setState calls, well before the next RAF), so this is
    // exactly "the next presented frame after the resulting state change
    // commits" per the ticket.
    const tick = (rafNowMs: number) => {
      if (finishedRef.current) return;

      const pending = pendingRef.current;
      if (pending !== null) {
        pendingRef.current = null;
        if (missTimerRef.current !== null) {
          clearTimeout(missTimerRef.current);
          missTimerRef.current = null;
        }
        const candidateOffsetMs = pending.jsNowAtPressMs - pending.nativeTimestampMs;
        minCandidateOffsetMsRef.current =
          minCandidateOffsetMsRef.current === null
            ? candidateOffsetMs
            : Math.min(minCandidateOffsetMsRef.current, candidateOffsetMs);
        rawTapsRef.current.push({
          nativeTimestampMs: pending.nativeTimestampMs,
          rafPresentedMs: rafNowMs,
          candidateOffsetMs,
        });
        maybeFinishIfEnough();
      }

      rafHandleRef.current = requestAnimationFrame(tick);
    };

    rafHandleRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafHandleRef.current !== null) cancelAnimationFrame(rafHandleRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: flash ? COLOR_LIGHT : COLOR_DARK }]}>
      <Pressable testID="touch-target" style={styles.touchable} onPressIn={handlePressIn}>
        <Text style={[styles.text, { color: flash ? COLOR_DARK : COLOR_LIGHT }]}>touch.latency</Text>
        <Text style={[styles.subtext, { color: flash ? COLOR_DARK : COLOR_LIGHT }]}>
          taps: {tapCount} (target {minSamples})
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  touchable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 28,
    fontWeight: '700',
  },
  subtext: {
    fontSize: 16,
    marginTop: 8,
  },
});
