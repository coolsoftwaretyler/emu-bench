/**
 * Frame recorder (SPEC.md §9): a frame-callback ring buffer that timestamps
 * every rendered frame, producing `{samples_ms, median, p95, p99,
 * droppedPct, longestStallMs}`.
 *
 * Uses `requestAnimationFrame` -- RN's cross-platform frame callback -- so
 * the exact same JS mechanism drives frame timing on both Android and iOS
 * (SPEC.md §9: "Must use the same JS mechanism on both platforms").
 */

import { median, p95, p99 } from './stats';

export type FrameRecorderStats = {
  /** Inter-frame intervals in ms, one per recorded frame (after the first). */
  samples_ms: number[];
  median: number;
  p95: number;
  p99: number;
  /** % of frames whose interval exceeded 1.5x the detected frame budget. */
  droppedPct: number;
  /** Longest single inter-frame gap observed, in ms. */
  longestStallMs: number;
  /** Empirically detected refresh interval (ms) used as the frame budget. */
  detectedFrameBudgetMs: number;
};

/**
 * Records frame-to-frame intervals via `requestAnimationFrame` for
 * `durationMs`, then resolves with the computed stats. Call `start()` to
 * begin; the returned promise resolves once `durationMs` has elapsed.
 */
export class FrameRecorder {
  private timestamps: number[] = [];
  private rafHandle: number | null = null;
  private startTime = 0;
  private durationMs: number;
  private resolveFn: ((stats: FrameRecorderStats) => void) | null = null;

  constructor(durationMs: number) {
    this.durationMs = durationMs;
  }

  start(): Promise<FrameRecorderStats> {
    return new Promise((resolve) => {
      this.resolveFn = resolve;
      this.startTime = performance.now();
      this.timestamps = [this.startTime];
      this.rafHandle = requestAnimationFrame(this.tick);
    });
  }

  private tick = (now: number): void => {
    this.timestamps.push(now);
    if (now - this.startTime >= this.durationMs) {
      this.finish();
      return;
    }
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private finish(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    const stats = computeFrameStats(this.timestamps);
    this.resolveFn?.(stats);
  }

  /** Stops recording early (e.g. scene teardown) without resolving. */
  cancel(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }
}

/**
 * Computes frame stats from a list of raw frame timestamps (ms, from
 * `performance.now()`, one entry per rendered frame including the first).
 * Exported standalone so it can be unit-tested without a real RAF loop.
 */
export function computeFrameStats(timestamps: number[]): FrameRecorderStats {
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }

  if (intervals.length === 0) {
    return {
      samples_ms: [],
      median: 0,
      p95: 0,
      p99: 0,
      droppedPct: 0,
      longestStallMs: 0,
      detectedFrameBudgetMs: 0,
    };
  }

  // The empirical frame budget is the median interval: robust to occasional
  // stalls/drops while adapting to whatever refresh rate the device is
  // actually running (60Hz vs 120Hz ProMotion-class), per the ticket's
  // "plausible ~60/120 Hz" acceptance criterion -- neither rate is hardcoded.
  const frameBudgetMs = median(intervals);
  const droppedThresholdMs = frameBudgetMs * 1.5;
  const droppedCount = intervals.filter((i) => i > droppedThresholdMs).length;

  return {
    samples_ms: intervals,
    median: frameBudgetMs,
    p95: p95(intervals),
    p99: p99(intervals),
    droppedPct: (droppedCount / intervals.length) * 100,
    longestStallMs: Math.max(...intervals),
    detectedFrameBudgetMs: frameBudgetMs,
  };
}
