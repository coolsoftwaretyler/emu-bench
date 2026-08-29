// @ts-check
/**
 * Benchmark registry (SPEC.md §4, ticket T01 scope). A benchmark is
 * `{ id, group, legs, kind, unit, run(ctx) -> samples }`. Later tickets
 * (T03 kernels, T05/T06 rig scenes, T08 fence, §11 scenarios) call
 * `register()` to add their entries; `run --groups` iterates whatever is
 * registered, so groups with no registered benchmarks simply do nothing
 * yet (not an error) — most of the matrix is out of scope for T01.
 */

/** @type {import('./types.js').BenchmarkEntry[]} */
const entries = [];

/**
 * @param {import('./types.js').BenchmarkEntry} entry
 */
export function register(entry) {
  if (entries.some((e) => e.id === entry.id)) {
    throw new Error(`registry: duplicate benchmark id "${entry.id}"`);
  }
  entries.push(entry);
}

/**
 * @returns {import('./types.js').BenchmarkEntry[]} a copy of the registry
 */
export function allBenchmarks() {
  return [...entries];
}

/**
 * @param {number[]} groups
 * @returns {import('./types.js').BenchmarkEntry[]}
 */
export function benchmarksForGroups(groups) {
  return entries.filter((e) => groups.includes(e.group));
}

/**
 * Test-only escape hatch: clears the registry. Not used by CLI code paths.
 */
export function _clearForTests() {
  entries.length = 0;
}
