/**
 * Startup marker (SPEC.md §9): captures the native process-start -> JS
 * first-meaningful-render delta that feeds the `startup.tti` scene.
 *
 * The native anchor comes from `ResultsFile.getProcessStartTimeMs()` (see
 * android/app/src/main/java/com/emubench/rig/ResultsFileModule.kt and
 * ios/RigApp/ResultsFileModule.m) -- a real native process-start epoch-ms
 * timestamp on both platforms. `firstRenderTimeMs` is supplied by the
 * scene harness at first-meaningful-render (post-mount, post-paint).
 */

import { getProcessStartTimeMs } from './nativeResultsFile';

export type StartupMarkerResult = {
  /** Epoch ms of native process start (from the ResultsFile native module). */
  nativeStartTimeMs: number;
  /** Epoch ms of first-meaningful-render (caller-supplied). */
  firstRenderTimeMs: number;
  /** `startup.tti` delta in ms: firstRenderTimeMs - nativeStartTimeMs. */
  ttiMs: number;
};

/**
 * Computes the startup.tti delta given the timestamp of first-meaningful-render.
 * @param firstRenderTimeMs epoch ms (`Date.now()`) at first-meaningful-render.
 */
export async function computeStartupMarker(
  firstRenderTimeMs: number,
): Promise<StartupMarkerResult> {
  const nativeStartTimeMs = await getProcessStartTimeMs();
  return {
    nativeStartTimeMs,
    firstRenderTimeMs,
    ttiMs: firstRenderTimeMs - nativeStartTimeMs,
  };
}
