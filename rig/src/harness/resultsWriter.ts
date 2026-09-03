/**
 * Results writer (SPEC.md §9): writes a scene's results JSON to
 * `<documents>/embench-results.json`, file-based extraction contract --
 * the host pulls the file with `adb pull` / `simctl get_app_container ...
 * data` + `cp`. No network dependency; transport is never part of a
 * measurement.
 */

import { writeFile } from './nativeResultsFile';

export const RESULTS_FILENAME = 'embench-results.json';

export type SceneResultsPayload = {
  sceneId: string;
  params: Record<string, string>;
  startedAtIso: string;
  finishedAtIso: string;
  /** Scene-specific measurement payload (frame stats, TTI, ops/s, etc). */
  measurement: unknown;
};

/**
 * Writes `payload` as pretty-printed JSON to `embench-results.json` in the
 * app's documents directory. Returns the absolute path written.
 */
export async function writeSceneResults(payload: SceneResultsPayload): Promise<string> {
  const json = JSON.stringify(payload, null, 2);
  return writeFile(RESULTS_FILENAME, json);
}
