// @ts-check
/**
 * Group 2 (Hermes) + Group 5 (storage) registry integration (PLAN.md §4,
 * ticket T05 scope: "All scenes register with the T04 harness and are
 * runnable via emubench://scene/<id>; add registry entries so `emu-bench
 * run --groups 2,5` executes them on legs B and C."). Registers one
 * BenchmarkEntry per scene id, each supporting legs b/c only -- these are
 * rig-app scenes (SPEC.md §9), and Group 2's whole premise (H3) is
 * comparing the *same* Hermes bytecode across the emulator and simulator,
 * so there is no leg-A analog the way Group 1's kernels have one.
 *
 * Each entry's `run(ctx)` drives the scene end to end via the T04 host
 * helpers in rig-host.js: launch the scene by deep link, poll for
 * completion, pull the results JSON, then extract that scene's raw
 * sample array from the measurement payload the scene itself computed
 * (every scene already reports `samples_ms` alongside its own
 * median/p95/etc -- see e.g. rig/src/scenes/HermesJsonParseScene.tsx --
 * so the registry/stats pipeline's own summarize() recomputes those over
 * the untouched raw samples rather than trusting the scene's numbers
 * blind).
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { register } from './registry.js';
import {
  awaitAndPullResultsAndroid,
  awaitAndPullResultsIos,
  ensureAdbRoot,
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
  launchSceneAndroid,
  launchSceneIos,
} from './rig-host.js';

const scratchDir = fileURLToPath(new URL('../results/.scratch/', import.meta.url));

/**
 * Runs one rig scene end to end on the given leg and returns its parsed
 * `measurement` payload (SPEC.md §9 results shape:
 * `{sceneId, params, startedAtIso, finishedAtIso, measurement}`).
 * @param {string} sceneId
 * @param {Record<string, string|number>} params
 * @param {'b'|'c'} leg
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function runSceneAndGetMeasurement(sceneId, params, leg, timeoutMs) {
  const destPath = path.join(
    scratchDir,
    `${sceneId.replace(/\./g, '-')}-leg-${leg}.local.json`,
  );

  if (leg === 'b') {
    const serial = await firstAndroidDeviceSerial();
    if (!serial) {
      throw new Error(`rig-scenes: no Android device/emulator found for scene "${sceneId}"`);
    }
    await ensureAdbRoot({ serial });
    await launchSceneAndroid(sceneId, params, { serial });
    await awaitAndPullResultsAndroid({ serial, destPath, timeoutMs });
  } else {
    const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
    await launchSceneIos(sceneId, params, { udid });
    await awaitAndPullResultsIos({ udid, destPath, timeoutMs });
  }

  const json = await readFile(destPath, 'utf8');
  const parsed = JSON.parse(json);
  return parsed.measurement;
}

/**
 * Default extraction timeout. Comfortably covers the plain Hermes/read
 * scenes (all finish in low single-digit seconds); the fsync-heavy scenes
 * override this explicitly below -- manual testing measured
 * `sqlite.insert_fsync` (the pathological 10k-implicit-transaction case
 * PLAN.md §4 Group 5 / H7 predicts as the suite's largest gap) taking
 * ~136s on the Android emulator (rowsPerSec ~83 vs iOS's ~2667 -- a >30x
 * gap, well past the ticket's >=5x acceptance threshold), so 30s or even
 * 120s isn't enough headroom for that scene on that leg.
 * @type {number}
 */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Generous headroom for the fsync-per-row scenes (measured ~136s on the emulator; see DEFAULT_TIMEOUT_MS doc). */
const FSYNC_TIMEOUT_MS = 300_000;
/** Headroom for io.files' 500 MB streamed write+read on top of 1,000 small-file round trips. */
const IO_FILES_TIMEOUT_MS = 180_000;

/**
 * @param {string} sceneId
 * @param {Record<string, string|number>} params
 * @param {import('./types.js').RunContext} ctx
 * @param {(measurement: any) => number[]} extractSamples
 * @param {number} [timeoutMs]
 * @returns {Promise<number[]>}
 */
async function runRigScene(sceneId, params, ctx, extractSamples, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (ctx.leg !== 'b' && ctx.leg !== 'c') {
    throw new Error(`rig-scenes: scene "${sceneId}" only supports legs b/c, got "${ctx.leg}"`);
  }
  const measurement = await runSceneAndGetMeasurement(sceneId, params, ctx.leg, timeoutMs);
  const samples = extractSamples(measurement);
  if (!Array.isArray(samples) || samples.some((s) => typeof s !== 'number')) {
    throw new Error(`rig-scenes: scene "${sceneId}" did not yield a numeric samples array`);
  }
  return samples;
}

/**
 * Registers every Group 2 (Hermes) + Group 5 (storage) scene as a
 * BenchmarkEntry. Called as a side effect of importing this module,
 * matching src/kernels.js's `registerKernelBenchmarks()` precedent (kept
 * as an explicit exported function rather than top-level side effects so
 * run.js's import remains an explicit, greppable call site).
 */
export function registerRigSceneBenchmarks() {
  // --- Group 2: Hermes suite (PLAN.md §4 Group 2, H3) ---

  register({
    id: 'hermes.json_parse',
    group: 2,
    legs: ['b', 'c'],
    kind: 'micro',
    unit: 'ms_per_op',
    async run(ctx) {
      return runRigScene('hermes.json_parse', { samples: 32 }, ctx, (m) => m.samples_ms);
    },
  });

  register({
    id: 'hermes.collections',
    group: 2,
    legs: ['b', 'c'],
    kind: 'micro',
    unit: 'ms_per_op',
    async run(ctx) {
      return runRigScene('hermes.collections', { samples: 32 }, ctx, (m) => m.samples_ms);
    },
  });

  register({
    id: 'hermes.strings',
    group: 2,
    legs: ['b', 'c'],
    kind: 'micro',
    unit: 'ms_per_op',
    async run(ctx) {
      return runRigScene('hermes.strings', { samples: 32 }, ctx, (m) => m.samples_ms);
    },
  });

  register({
    id: 'hermes.worklet',
    group: 2,
    legs: ['b', 'c'],
    kind: 'micro',
    unit: 'ms_per_op',
    async run(ctx) {
      return runRigScene('hermes.worklet', { samples: 32 }, ctx, (m) => m.samples_ms);
    },
  });

  // --- Group 5: storage suite (PLAN.md §4 Group 5, H7) ---

  register({
    id: 'sqlite.insert_fsync',
    group: 5,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_row',
    async run(ctx) {
      return runRigScene(
        'sqlite.insert_fsync',
        { rows: 10_000 },
        ctx,
        (m) => m.samples_ms,
        FSYNC_TIMEOUT_MS,
      );
    },
  });

  register({
    id: 'sqlite.insert_txn',
    group: 5,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_row',
    async run(ctx) {
      return runRigScene('sqlite.insert_txn', { rows: 10_000 }, ctx, (m) => m.samples_ms);
    },
  });

  register({
    id: 'sqlite.reads',
    group: 5,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_op',
    async run(ctx) {
      return runRigScene('sqlite.reads', { rows: 10_000 }, ctx, (m) => m.samples_ms);
    },
  });

  // wal_toggle reports two named sub-results in one measurement payload
  // (rig/src/scenes/SqliteWalToggleScene.tsx: `{walOff, walOn}`) --
  // registered as two BenchmarkEntry ids, each launching the scene
  // independently (same idempotent precedent as src/kernels.js's per-entry
  // re-push: simpler and correct under any call order, at the cost of
  // running the scene twice) and extracting its own sub-result's samples.
  register({
    id: 'sqlite.wal_toggle.off',
    group: 5,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_row',
    async run(ctx) {
      // Runs the walOff *and* walOn halves in the same scene launch (see
      // SqliteWalToggleScene.tsx), so this needs the same fsync-per-row
      // headroom as sqlite.insert_fsync even though it's extracting the
      // walOff half specifically.
      return runRigScene(
        'sqlite.wal_toggle',
        { rows: 10_000 },
        ctx,
        (m) => m.walOff.samples_ms,
        FSYNC_TIMEOUT_MS,
      );
    },
  });

  register({
    id: 'sqlite.wal_toggle.on',
    group: 5,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_row',
    async run(ctx) {
      return runRigScene(
        'sqlite.wal_toggle',
        { rows: 10_000 },
        ctx,
        (m) => m.walOn.samples_ms,
        FSYNC_TIMEOUT_MS,
      );
    },
  });

  // io.files reports two named sub-measurements (`smallFiles`,
  // `largeFile`) -- `largeFile` is deliberately a single streamed
  // write+read (PLAN.md §4 Group 5: "one 500 MB streamed write"), so it
  // has no per-op samples array to feed the n>=1 stats pipeline; only
  // `smallFiles`' write+read op arrays are registered as BenchmarkEntry
  // ids here. The large-file MB/s numbers still land in the pulled
  // results JSON (results/.scratch/io-files-leg-*.local.json) for
  // inspection even though they aren't folded into a `benchmarks[]` row.
  register({
    id: 'io.files.write',
    group: 5,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_op',
    async run(ctx) {
      return runRigScene(
        'io.files',
        { fileCount: 1000, largeFileBytes: 500 * 1024 * 1024 },
        ctx,
        (m) => m.smallFiles.write.samples_ms,
        IO_FILES_TIMEOUT_MS,
      );
    },
  });

  register({
    id: 'io.files.read',
    group: 5,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_op',
    async run(ctx) {
      return runRigScene(
        'io.files',
        { fileCount: 1000, largeFileBytes: 500 * 1024 * 1024 },
        ctx,
        (m) => m.smallFiles.read.samples_ms,
        IO_FILES_TIMEOUT_MS,
      );
    },
  });
}
