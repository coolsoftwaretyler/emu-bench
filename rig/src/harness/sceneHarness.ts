/**
 * Scene harness (SPEC.md §9): standard lifecycle every scene follows --
 * mount -> optional warmup -> measure -> write results -> render
 * `bench-done` testID (Maestro-visible) + log `EMUBENCH_DONE`.
 *
 * A scene component receives `SceneProps` (parsed params + a `finish`
 * callback) and is responsible only for its own measurement; this module
 * owns writing the results file and emitting the completion signal so
 * every scene reports done the same way.
 */

import { writeSceneResults } from './resultsWriter';

export type SceneProps = {
  sceneId: string;
  params: Record<string, string>;
  /** Call once the scene has finished measuring, with its measurement payload. */
  finish: (measurement: unknown) => void;
};

export type SceneRunResult = {
  resultsPath: string;
  payload: {
    sceneId: string;
    params: Record<string, string>;
    startedAtIso: string;
    finishedAtIso: string;
    measurement: unknown;
  };
};

/**
 * Drives one scene run to completion: records start time, awaits the
 * scene's `finish(measurement)` call, writes the results file, and logs
 * `EMUBENCH_DONE`. The caller (the scene screen) is responsible for
 * rendering the `bench-done` testID once this resolves.
 */
export function createSceneRunner(sceneId: string, params: Record<string, string>) {
  const startedAtIso = new Date().toISOString();

  return {
    startedAtIso,
    async complete(measurement: unknown): Promise<SceneRunResult> {
      const finishedAtIso = new Date().toISOString();
      const payload = { sceneId, params, startedAtIso, finishedAtIso, measurement };
      const resultsPath = await writeSceneResults(payload);
      // eslint-disable-next-line no-console
      console.log('EMUBENCH_DONE', JSON.stringify({ sceneId, resultsPath }));
      return { resultsPath, payload };
    },
  };
}

/**
 * Parses `durationMs` from scene params (present on most scenes), falling
 * back to `fallbackMs` when absent or unparseable.
 */
export function parseDurationMs(params: Record<string, string>, fallbackMs: number): number {
  const raw = params.durationMs;
  if (raw === undefined) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}
