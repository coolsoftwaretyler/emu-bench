// @ts-check
/**
 * Built-in trivial demo benchmark (ticket T01, acceptance criterion 1). A
 * no-op timing loop registered under group 1, leg A only, so
 * `./bin/emu-bench run --groups 1 --label smoke` has something real to
 * execute before the Group 1 C kernel suite (T03) exists. T03 will register
 * the real Group 1 workloads (SPEC.md §8) alongside this; nothing here
 * conflicts with that — the id is namespaced `demo.*` on purpose.
 */

import { register } from '../registry.js';

/**
 * Times `iterations` no-op loop passes with `process.hrtime.bigint()` and
 * returns each lap's duration in nanoseconds.
 * @param {number} iterations
 * @returns {number[]}
 */
function timeNoopLoop(iterations) {
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    // The "workload": deliberately nothing. This benchmark exists to prove
    // the orchestrator's plumbing (registry -> execution -> stats ->
    // schema-valid results file), not to measure anything real.
    const end = process.hrtime.bigint();
    samples.push(Number(end - start));
  }
  return samples;
}

register({
  id: 'demo.noop_loop',
  group: 1,
  legs: ['a'],
  kind: 'micro',
  unit: 'ns_per_op',
  async run(_ctx) {
    // n>=30 per PLAN.md §5 micro floor, plus room for 2 warmup discards.
    return timeNoopLoop(32);
  },
});
