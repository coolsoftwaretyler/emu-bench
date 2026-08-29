// @ts-check
/**
 * Group 1 registry integration (PLAN.md §4 Group 1, SPEC.md §8, ticket T03
 * scope: "group-1 benchmarks that build (if needed), deploy, and execute
 * per leg"). Registers one BenchmarkEntry per kernel name (see
 * `kernels/main.c`'s BENCHES table) supporting all three legs; each
 * entry's `run(ctx)` builds the right binary if missing, deploys it if the
 * leg needs deployment (B: adb push; C: none, simctl spawn reaches the
 * binary directly), executes it filtered to that one kernel via
 * `--bench <name>`, and parses its JSON-lines stdout into the raw
 * `sample_ns_per_op` values the registry/stats pipeline expects.
 *
 * Leg mechanics (SPEC.md §1 step 4, §8):
 *   - Leg A: run the macOS binary directly in a local shell.
 *   - Leg B: `adb push` to /data/local/tmp, `chmod +x`, `adb shell` to run.
 *   - Leg C: `xcrun simctl spawn booted` to run inside the booted
 *     simulator (CoreSimulator apps share the Mac's filesystem, so no
 *     push step is needed — the host-built binary path is directly
 *     reachable).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants as fsConstants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { register } from './registry.js';

const execFileAsync = promisify(execFile);

const kernelsDir = fileURLToPath(new URL('../kernels/', import.meta.url));

/** Kernel names, matching kernels/main.c's BENCHES table exactly (kept as
 * a plain list here rather than parsed from `--list` at import time, so
 * registration doesn't require a built binary to exist yet — `--list`
 * still exists as a human/debugging entry point into the C binary
 * itself). */
const KERNEL_NAMES = [
  'sha256',
  'zlib_deflate',
  'matmul_1024',
  'stream_triad',
  'malloc_churn',
  'clock_gettime_loop',
  'getpid_loop',
  'pthread_pingpong',
];

/** ADB device serial for leg B. Matches the convention already
 * established in src/android-sdk.js's bootProbe(): bench-tuned/
 * bench-default are run one at a time as the sole emulator instance,
 * which ADB always numbers `emulator-5554`. */
const EMULATOR_SERIAL = 'emulator-5554';

const DEVICE_TMP_PATH = '/data/local/tmp/embench-kernels';

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
 * Runs `make -C kernels <target>` if the target binary doesn't exist yet
 * (ticket scope: "benchmarks that build (if needed)"). Building is
 * idempotent — re-running `make` when the binary already exists is a
 * cheap no-op via the Makefile's own dependency check, but we skip even
 * that invocation when possible so a full `run` across many kernel
 * entries doesn't shell out to `make` once per entry.
 * @param {'macos'|'android'|'iossim'} target
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
      `kernels: 'make -C kernels ${target}' failed: ${err?.message ?? err}\n${stdout}\n${stderr}`,
    );
  }
  if (!(await fileExists(binaryPath))) {
    throw new Error(`kernels: 'make -C kernels ${target}' did not produce ${binaryPath}`);
  }
}

/**
 * Parses the C binary's JSON-lines stdout (SPEC.md §8: "JSON-lines output
 * on stdout, {bench, ns_per_op, ...}, parsed by the runner") into raw
 * `sample_ns_per_op` values for the one kernel requested. Deliberately a
 * tiny hand-rolled line parser (schema.js's precedent: this suite ships
 * zero runtime dependencies) rather than JSON.parse-ing the whole stream
 * at once, since a misbehaving line elsewhere in stdout shouldn't corrupt
 * every sample.
 * @param {string} stdout
 * @param {string} kernelName
 * @returns {number[]}
 */
function parseKernelSamples(stdout, kernelName) {
  /** @type {number[]} */
  const samples = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // Non-JSON stray line (e.g. a stderr line interleaved onto stdout by the shell) — skip rather than fail the whole run.
    }
    if (parsed?.bench !== kernelName) continue;
    if (typeof parsed.sample_ns_per_op === 'number') {
      samples.push(parsed.sample_ns_per_op);
    }
  }
  return samples;
}

/**
 * Leg A: build (if needed) and run the macOS binary directly.
 * @param {string} kernelName
 * @param {number} samples
 * @returns {Promise<number[]>}
 */
async function runLegA(kernelName, samples) {
  const binaryPath = path.join(kernelsDir, 'build', 'macos', 'embench-kernels');
  await ensureBuilt('macos', binaryPath);
  const { stdout } = await execFileAsync(
    binaryPath,
    ['--samples', String(samples), '--bench', kernelName],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseKernelSamples(stdout, kernelName);
}

/**
 * Leg B: build (if needed), `adb push` + `chmod +x` (deploy, once per
 * process — not re-pushed per kernel), then `adb shell` to execute
 * filtered to one kernel.
 * @param {string} kernelName
 * @param {number} samples
 * @returns {Promise<number[]>}
 */
async function runLegB(kernelName, samples) {
  const binaryPath = path.join(kernelsDir, 'build', 'android', 'embench-kernels');
  await ensureBuilt('android', binaryPath);

  // Deploy: push + chmod. adb push is itself idempotent/cheap (overwrites
  // the same path), so rather than tracking "already pushed this run" in
  // module state (which would need resetting between `run` invocations
  // in the same process, e.g. tests), every kernel entry's execution
  // re-pushes. This trades a small amount of redundant adb traffic for
  // simplicity and correctness under any call order.
  await execFileAsync('adb', ['-s', EMULATOR_SERIAL, 'push', binaryPath, DEVICE_TMP_PATH], {
    encoding: 'utf8',
  });
  await execFileAsync('adb', ['-s', EMULATOR_SERIAL, 'shell', 'chmod', '+x', DEVICE_TMP_PATH], {
    encoding: 'utf8',
  });

  const { stdout } = await execFileAsync(
    'adb',
    ['-s', EMULATOR_SERIAL, 'shell', DEVICE_TMP_PATH, '--samples', String(samples), '--bench', kernelName],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseKernelSamples(stdout, kernelName);
}

/**
 * Leg C: build (if needed), then `xcrun simctl spawn booted` to execute
 * inside the booted simulator. No push step — CoreSimulator apps run as
 * plain Mac processes sharing the host filesystem (PLAN.md §3), so the
 * host-built binary's path is directly spawnable.
 * @param {string} kernelName
 * @param {number} samples
 * @returns {Promise<number[]>}
 */
async function runLegC(kernelName, samples) {
  const binaryPath = path.join(kernelsDir, 'build', 'iossim', 'embench-kernels');
  await ensureBuilt('iossim', binaryPath);
  const { stdout } = await execFileAsync(
    'xcrun',
    ['simctl', 'spawn', 'booted', binaryPath, '--samples', String(samples), '--bench', kernelName],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseKernelSamples(stdout, kernelName);
}

/** @type {Record<string, (kernelName: string, samples: number) => Promise<number[]>>} */
const LEG_RUNNERS = { a: runLegA, b: runLegB, c: runLegC };

/**
 * Registers one BenchmarkEntry per kernel name, each supporting all three
 * legs. `kind: 'micro'` per PLAN.md §5 (n>=30 floor) — matches the C
 * binary's own `--samples` default of 30. Called as a side effect of
 * importing this module (matching src/benchmarks/demo.js's precedent).
 */
export function registerKernelBenchmarks() {
  for (const kernelName of KERNEL_NAMES) {
    register({
      id: `kernel.${kernelName}`,
      group: 1,
      legs: ['a', 'b', 'c'],
      kind: 'micro',
      unit: 'ns_per_op',
      async run(ctx) {
        const runner = LEG_RUNNERS[ctx.leg];
        if (!runner) {
          throw new Error(`kernels: no runner for leg "${ctx.leg}"`);
        }
        // The C binary's own --samples already yields one JSON line per
        // sample with internal warmup-free repetition baked into each
        // sample's ns_per_op (kernels/main.c's time_pass loops until the
        // ~1s floor) — request PLAN §5's n>=30 micro floor directly, plus
        // headroom for run.js's 2 warmup discards.
        return runner(kernelName, 32);
      },
    });
  }
}

export { KERNEL_NAMES, parseKernelSamples };
