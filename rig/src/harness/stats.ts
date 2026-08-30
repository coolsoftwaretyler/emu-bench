/**
 * Percentile helpers for the frame recorder (SPEC.md §9). Mirrors the
 * nearest-rank percentile convention used by the host-side CLI's
 * `src/stats.js` (not imported directly -- the rig is a separate RN package
 * with its own dependency tree -- but kept numerically identical so a scene's
 * `median`/`p95`/`p99` mean the same thing on both sides of the fence).
 */

function sorted(samples: number[]): number[] {
  return [...samples].sort((a, b) => a - b);
}

/** Nearest-rank percentile. `p` is in [0, 1] (e.g. 0.95 for p95). */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const s = sorted(samples);
  const rank = Math.ceil(p * s.length) - 1;
  const idx = Math.min(Math.max(rank, 0), s.length - 1);
  return s[idx];
}

export function median(samples: number[]): number {
  if (samples.length === 0) return 0;
  const s = sorted(samples);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function p95(samples: number[]): number {
  return percentile(samples, 0.95);
}

export function p99(samples: number[]): number {
  return percentile(samples, 0.99);
}

/**
 * Mean and coefficient of variation (added for ticket T05's scenes, which
 * report a `cv` field alongside median/p95/p99 -- matching the host-side
 * `src/stats.js`'s summary shape numerically (SPEC.md §7 `benchmarks[]`),
 * kept as a straight port rather than importing across the rig/host
 * package boundary, same precedent as this file's own percentile/median.
 */
export function mean(samples: number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

export function stddev(samples: number[]): number {
  if (samples.length < 2) return 0;
  const m = mean(samples);
  const variance = samples.reduce((acc, x) => acc + (x - m) ** 2, 0) / (samples.length - 1);
  return Math.sqrt(variance);
}

/** Coefficient of variation: stddev / mean. PLAN.md §5, glossary "CV". */
export function cv(samples: number[]): number {
  const m = mean(samples);
  if (m === 0) return 0;
  return stddev(samples) / m;
}
