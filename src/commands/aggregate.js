// @ts-check
/**
 * `emu-bench aggregate` — stub for T01 (full report rendering is T14,
 * SPEC.md §5). T01 only needs the arm64 hard gate to be real.
 */

import { requireAppleSilicon } from '../arm64-gate.js';

/**
 * @param {{ out?: string }} _flags
 */
export async function aggregateCommand(_flags) {
  requireAppleSilicon();
  console.log('emu-bench aggregate: stub (report rendering lands in T14 — see SPEC.md §5).');
}
