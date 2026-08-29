// @ts-check
/**
 * `emu-bench doctor` — stub for T01 (full logic is T02, SPEC.md §5 table).
 * T01 only needs the arm64 hard gate to be real; everything else is a
 * clearly-labeled stub so `doctor` doesn't crash if invoked early.
 */

import { requireAppleSilicon } from '../arm64-gate.js';

export async function doctorCommand() {
  requireAppleSilicon();
  console.log('emu-bench doctor: stub (full preflight checks land in T02 — see SPEC.md §5).');
  console.log('Apple Silicon check: OK.');
}
