// @ts-check
/**
 * Statistics helpers (SPEC.md §12, PLAN.md §5). Percentiles over averages —
 * see PLAN.md §2 principle 3 ("Tails over averages").
 */

/**
 * @param {number[]} samples
 * @returns {number[]} a new array, sorted ascending. Does not mutate input.
 */
function sorted(samples) {
  return [...samples].sort((a, b) => a - b);
}

/**
 * Nearest-rank percentile. `p` is in [0, 1] (e.g. 0.95 for p95).
 * @param {number[]} samples
 * @param {number} p
 * @returns {number}
 */
export function percentile(samples, p) {
  if (samples.length === 0) return 0;
  const s = sorted(samples);
  const rank = Math.ceil(p * s.length) - 1;
  const idx = Math.min(Math.max(rank, 0), s.length - 1);
  return s[idx];
}

/** @param {number[]} samples @returns {number} */
export function median(samples) {
  if (samples.length === 0) return 0;
  const s = sorted(samples);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** @param {number[]} samples @returns {number} */
export function p95(samples) {
  return percentile(samples, 0.95);
}

/** @param {number[]} samples @returns {number} */
export function p99(samples) {
  return percentile(samples, 0.99);
}

/** @param {number[]} samples @returns {number} */
export function mean(samples) {
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/** @param {number[]} samples @returns {number} */
export function stddev(samples) {
  if (samples.length < 2) return 0;
  const m = mean(samples);
  const variance =
    samples.reduce((acc, x) => acc + (x - m) ** 2, 0) / (samples.length - 1);
  return Math.sqrt(variance);
}

/**
 * Coefficient of variation: stddev / mean. PLAN.md §5, glossary "CV" — above
 * 0.10 a benchmark's repeats wobble too much to trust (flagged, not thrown
 * away).
 * @param {number[]} samples
 * @returns {number}
 */
export function cv(samples) {
  const m = mean(samples);
  if (m === 0) return 0;
  return stddev(samples) / m;
}

/**
 * Discards the first `count` samples (warmup discards; PLAN.md §5: "discard
 * 2 warmups"). If there aren't enough samples to discard that many and keep
 * at least one, returns the input unchanged rather than emptying it.
 * @param {number[]} samples
 * @param {number} count
 * @returns {{ kept: number[], discarded: number }}
 */
export function discardWarmups(samples, count) {
  if (count <= 0 || samples.length <= count) {
    return { kept: [...samples], discarded: 0 };
  }
  return { kept: samples.slice(count), discarded: count };
}

/**
 * Computes the full summary block used in a `benchmarks[]` entry
 * (SPEC.md §7): n, samples, median, p95, p99, cv. Does not perform warmup
 * discarding itself — callers pass already-discarded samples plus the count
 * they discarded.
 * @param {number[]} samples raw (post-warmup-discard) samples
 * @param {number} warmupsDiscarded
 * @returns {{ n: number, warmupsDiscarded: number, samples: number[], median: number, p95: number, p99: number, cv: number }}
 */
export function summarize(samples, warmupsDiscarded = 0) {
  return {
    n: samples.length,
    warmupsDiscarded,
    samples,
    median: median(samples),
    p95: p95(samples),
    p99: p99(samples),
    cv: cv(samples),
  };
}
