// @ts-check
/**
 * Group 4 fence round-trip registry integration (PLAN.md §4 Group 4 / H6,
 * SPEC.md §10, ticket T08). Registers one BenchmarkEntry, `fence.roundtrip`,
 * supporting all three legs so the result reports as a ratio to native like
 * Group 1:
 *
 *   - Leg A: kernels/build/macos/fence_macos — the same Metal
 *     submit→wait loop as leg C, built as a native host CLI (SPEC.md §10).
 *   - Leg B: kernels/build/android/fence_android — EGL/GLES2 glFinish
 *     loop, `adb push` to /data/local/tmp + `adb shell` (same deploy
 *     mechanics as src/kernels.js's Group 1 entries).
 *   - Leg C: kernels/build/iossim/fence_iossim — Metal
 *     waitUntilCompleted loop via `xcrun simctl spawn booted`.
 *
 * Unlike the Group 1 kernels, `run(ctx)` returns `{samples, method}` (the
 * object form run.js accepts) rather than a bare samples array: the ticket
 * requires the per-leg `method` recorded in results — "egl-surfaceless" /
 * "egl-pbuffer" on Android (whichever context bootstrap the probe actually
 * achieved; the probe reports it in every JSON line, and this module
 * records what the probe said rather than assuming), "metal" on legs A/C,
 * and "skia-fallback" reserved for the documented in-rig fallback should
 * the EGL path ever stop working on some emulator stack.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants as fsConstants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { register } from './registry.js';

const execFileAsync = promisify(execFile);

const kernelsDir = fileURLToPath(new URL('../kernels/', import.meta.url));

/** Same single-emulator-instance convention as src/kernels.js. */
const EMULATOR_SERIAL = 'emulator-5554';

const DEVICE_TMP_PATH = '/data/local/tmp/fence_android';

/**
 * Samples requested from the probe: the ticket's ">= 1,000 iterations"
 * floor for the recorded n, plus headroom for run.js's 2 warmup discards
 * (same convention as src/kernels.js's 32-for-n>=30). Each sample already
 * averages the probe's internal batch of round trips (probe default 16),
 * so the underlying iteration count is 16x this.
 */
const FENCE_SAMPLES = 1002;

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `make -C kernels <target>` if the binary doesn't exist yet — same
 * build-if-needed contract as src/kernels.js's ensureBuilt, pointed at the
 * fence targets (fence-macos / fence-android / fence-iossim).
 * @param {'fence-macos'|'fence-android'|'fence-iossim'} target
 * @param {string} binaryPath
 * @returns {Promise<void>}
 */
async function ensureBuilt(target, binaryPath) {
  if (await fileExists(binaryPath)) return;
  try {
    await execFileAsync('make', ['-C', kernelsDir, target], {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (/** @type {any} */ err) {
    const stderr = err?.stderr ?? '';
    const stdout = err?.stdout ?? '';
    throw new Error(
      `fence: 'make -C kernels ${target}' failed: ${err?.message ?? err}\n${stdout}\n${stderr}`,
    );
  }
  if (!(await fileExists(binaryPath))) {
    throw new Error(`fence: 'make -C kernels ${target}' did not produce ${binaryPath}`);
  }
}

/**
 * Parses the probe's JSON-lines stdout (same line-by-line tolerance as
 * src/kernels.js's parseKernelSamples): collects every
 * `sample_us_per_roundtrip` and the `method` the probe reported. The
 * trailing `{"summary":true,...}` line carries no sample field, so it is
 * naturally skipped as a sample while still contributing `method`.
 * @param {string} stdout
 * @returns {{ samples: number[], method: string|undefined }}
 */
function parseFenceSamples(stdout) {
  /** @type {number[]} */
  const samples = [];
  /** @type {string|undefined} */
  let method;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // Stray non-JSON line — skip, don't fail the run.
    }
    if (parsed?.bench !== 'fence_roundtrip') continue;
    if (typeof parsed.method === 'string') method = parsed.method;
    if (typeof parsed.sample_us_per_roundtrip === 'number') {
      samples.push(parsed.sample_us_per_roundtrip);
    }
  }
  return { samples, method };
}

/**
 * @param {string} stdout
 * @param {string} leg
 * @returns {{ samples: number[], method: string }}
 */
function requireParsed(stdout, leg) {
  const { samples, method } = parseFenceSamples(stdout);
  if (samples.length === 0 || method === undefined) {
    throw new Error(`fence: leg ${leg} probe produced no parseable samples`);
  }
  return { samples, method };
}

/**
 * Leg A: build (if needed) and run the native macOS Metal probe directly.
 * @returns {Promise<{samples: number[], method: string}>}
 */
async function runLegA() {
  const binaryPath = path.join(kernelsDir, 'build', 'macos', 'fence_macos');
  await ensureBuilt('fence-macos', binaryPath);
  const { stdout } = await execFileAsync(binaryPath, ['--samples', String(FENCE_SAMPLES)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return requireParsed(stdout, 'a');
}

/**
 * Leg B: build (if needed), `adb push` + `chmod +x`, `adb shell` to run on
 * the emulator — the same deploy mechanics (and idempotent re-push
 * trade-off) as src/kernels.js's runLegB.
 * @returns {Promise<{samples: number[], method: string}>}
 */
async function runLegB() {
  const binaryPath = path.join(kernelsDir, 'build', 'android', 'fence_android');
  await ensureBuilt('fence-android', binaryPath);
  await execFileAsync('adb', ['-s', EMULATOR_SERIAL, 'push', binaryPath, DEVICE_TMP_PATH], {
    encoding: 'utf8',
  });
  await execFileAsync('adb', ['-s', EMULATOR_SERIAL, 'shell', 'chmod', '+x', DEVICE_TMP_PATH], {
    encoding: 'utf8',
  });
  const { stdout } = await execFileAsync(
    'adb',
    ['-s', EMULATOR_SERIAL, 'shell', DEVICE_TMP_PATH, '--samples', String(FENCE_SAMPLES)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return requireParsed(stdout, 'b');
}

/**
 * Leg C: build (if needed), run inside the booted simulator via
 * `xcrun simctl spawn booted` (no push step — CoreSimulator processes
 * share the host filesystem, PLAN.md §3).
 * @returns {Promise<{samples: number[], method: string}>}
 */
async function runLegC() {
  const binaryPath = path.join(kernelsDir, 'build', 'iossim', 'fence_iossim');
  await ensureBuilt('fence-iossim', binaryPath);
  const { stdout } = await execFileAsync(
    'xcrun',
    ['simctl', 'spawn', 'booted', binaryPath, '--samples', String(FENCE_SAMPLES)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return requireParsed(stdout, 'c');
}

/** @type {Record<string, () => Promise<{samples: number[], method: string}>>} */
const LEG_RUNNERS = { a: runLegA, b: runLegB, c: runLegC };

/**
 * Registers the fence round-trip probe (results id `fence.roundtrip`,
 * group 4 — picked up by `run --groups 4` alongside T07's
 * `touch.latency`). `kind: 'micro'`, though the entry's own FENCE_SAMPLES
 * (1002) far exceeds PLAN §5's n>=30 micro floor: the ticket pins this
 * probe's n at >= 1,000.
 */
export function registerFenceBenchmarks() {
  register({
    id: 'fence.roundtrip',
    group: 4,
    legs: ['a', 'b', 'c'],
    kind: 'micro',
    unit: 'us_per_roundtrip',
    // GPU-heavy (PLAN.md §5/§4 Group 4: "submits trivial GPU work and
    // blocks until it's confirmed done, over and over" -- 1,000+ rounds
    // of real GPU work per invocation) -- T13 orchestrator inserts a
    // cooldown after, on every leg (the host-thermal concern PLAN.md §5's
    // cooldown rule addresses applies regardless of which leg drove it).
    gpuHeavy: true,
    async run(ctx) {
      const runner = LEG_RUNNERS[ctx.leg];
      if (!runner) {
        throw new Error(`fence: no runner for leg "${ctx.leg}"`);
      }
      return runner();
    },
  });
}

export { parseFenceSamples };
