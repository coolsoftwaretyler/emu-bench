/**
 * Deterministic PRNG (ticket T05: "generate from a seeded PRNG at scene
 * start -- no fixture files"). Mulberry32 -- a small, fast, public-domain
 * 32-bit PRNG with good statistical quality for non-cryptographic use,
 * hand-rolled here rather than a dependency (D6, SPEC.md §2, keeps the
 * rig's dependency list closed; the C kernel suite's `xoshiro256**` in
 * kernels/prng.c is the same idea on the native side).
 *
 * A fixed seed on both platforms is what makes T05's determinism
 * acceptance criterion ("two consecutive runs of hermes.json_parse on the
 * same platform differ by < 10% median") meaningful: the workload itself
 * is byte-identical every run, so any variance is real host/environment
 * noise, not workload noise.
 */

export const DEFAULT_SEED = 0x5eed_1234;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random float in [min, max). */
export function randRange(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}

/** Random integer in [min, max]. */
export function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(randRange(rand, min, max + 1));
}

/** Picks a random element from a non-empty array. */
export function randChoice<T>(rand: () => number, items: T[]): T {
  return items[randInt(rand, 0, items.length - 1)];
}

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu',
];

/** Random lowercase word-ish token, for building deterministic strings/JSON text fields. */
export function randWord(rand: () => number): string {
  return randChoice(rand, WORDS);
}

/** Random sentence-ish string of `wordCount` words. */
export function randSentence(rand: () => number, wordCount: number): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(randWord(rand));
  return words.join(' ');
}
