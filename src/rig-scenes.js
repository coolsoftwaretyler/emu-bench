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
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { register } from './registry.js';
import {
  ANDROID_APP_ID,
  IOS_BUNDLE_ID,
  RESULTS_FILENAME,
  awaitAndPullResultsAndroid,
  awaitAndPullResultsIos,
  ensureAdbRoot,
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
  launchSceneAndroid,
  launchSceneIos,
} from './rig-host.js';

const execFileAsync = promisify(execFile);
const scratchDir = fileURLToPath(new URL('../results/.scratch/', import.meta.url));
const flowsDir = fileURLToPath(new URL('../flows/', import.meta.url));

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
 * Group 3 (ticket T06) Skia scenes run a fixed in-scene duration (8s
 * default, DEFAULT_DURATION_MS in the scene components) plus warmup (1s
 * default) -- comfortably inside DEFAULT_TIMEOUT_MS's 60s. `list.scroll`
 * defaults to a much longer in-scene duration (60s, per the ticket:
 * "default 60 s to serve as T12's power scenario") and its own params
 * below are pinned to that default explicitly, so it needs headroom above
 * that 60s scene-side duration for build/launch/animation/result-write
 * overhead on top.
 * @type {number}
 */
const LIST_SCROLL_TIMEOUT_MS = 120_000;
/**
 * Headroom for the Maestro flow's own 32-tap loop (ticket T07): each tap
 * involves a real UI Automator/XCUITest injection plus an
 * `extendedWaitUntil` settle, and manual verification measured full
 * 32-tap runs taking 60-80s end to end (Android ~77s, iOS in the same
 * range) -- well past DEFAULT_TIMEOUT_MS's 60s once app-launch overhead
 * is added on top.
 * @type {number}
 */
const TOUCH_LATENCY_TIMEOUT_MS = 180_000;

/**
 * @param {string} sceneId
 * @param {Record<string, string|number>} params
 * @param {import('./types.js').RunContext} ctx
 * @param {(measurement: any) => number[]} extractSamples
 * @param {number} [timeoutMs]
 * @param {(measurement: any) => void} [onMeasurement] optional hook given the
 *   full raw measurement before sample extraction -- used by `list.scroll`
 *   below to log its scroll-distance field (ticket T06 acceptance
 *   criterion: "log total px scrolled; must match") without adding a
 *   scene-specific return shape to every other caller of this function.
 * @returns {Promise<number[]>}
 */
async function runRigScene(
  sceneId,
  params,
  ctx,
  extractSamples,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onMeasurement,
) {
  if (ctx.leg !== 'b' && ctx.leg !== 'c') {
    throw new Error(`rig-scenes: scene "${sceneId}" only supports legs b/c, got "${ctx.leg}"`);
  }
  const measurement = await runSceneAndGetMeasurement(sceneId, params, ctx.leg, timeoutMs);
  onMeasurement?.(measurement);
  const samples = extractSamples(measurement);
  if (!Array.isArray(samples) || samples.some((s) => typeof s !== 'number')) {
    throw new Error(`rig-scenes: scene "${sceneId}" did not yield a numeric samples array`);
  }
  return samples;
}

/**
 * Drives `touch.latency` (ticket T07, PLAN.md §4 Group 4, H6) end to end
 * via the Maestro flow at `flows/touch-latency.yaml`, unlike every other
 * `runRigScene` caller above: this scene's whole point is that taps are
 * delivered by an external injection tool (Maestro), not synthesized by
 * the scene's own JS -- the ticket's "immune to injection-tool
 * differences" claim depends on the *same* tap-delivery mechanism running
 * on both legs, not on the host launching the scene and the scene
 * self-triggering its own state changes the way T05/T06 scenes do.
 *
 * The flow itself owns launching the app AND tapping (see that file's own
 * doc comment for why `openLink` is called twice -- a diagnosed Maestro
 * routing quirk on this Maestro/Xcode/simulator and Maestro/emulator
 * combination, confirmed via captured accessibility-hierarchy debug
 * output, not a timing race); this function's job is only to remove any
 * stale results file first (same precedent as `launchSceneAndroid`/
 * `launchSceneIos` in rig-host.js: a caller polling for the file
 * afterward must not mistake a leftover previous-run result for this
 * run's output), invoke `maestro test`, then reuse the existing
 * poll-and-pull helpers to retrieve the scene's own results file.
 * @param {'b'|'c'} leg
 * @returns {Promise<any>} the scene's raw `measurement` payload
 */
async function runTouchLatencySceneViaMaestro(leg) {
  const flowPath = path.join(flowsDir, 'touch-latency.yaml');
  const destPath = path.join(scratchDir, `touch-latency-leg-${leg}.local.json`);

  if (leg === 'b') {
    const serial = await firstAndroidDeviceSerial();
    if (!serial) {
      throw new Error('rig-scenes: no Android device/emulator found for scene "touch.latency"');
    }
    await ensureAdbRoot({ serial });
    // Best-effort stale-results cleanup, matching launchSceneAndroid's own
    // precedent -- ignores failure (e.g. first-ever run, file doesn't exist).
    await execFileAsync('adb', [
      '-s',
      serial,
      'shell',
      'rm',
      '-f',
      `/data/data/${ANDROID_APP_ID}/files/${RESULTS_FILENAME}`,
    ]).catch(() => {});
    await execFileAsync('maestro', ['--platform', 'android', '--udid', serial, 'test', flowPath], {
      timeout: TOUCH_LATENCY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    await awaitAndPullResultsAndroid({ serial, destPath, timeoutMs: TOUCH_LATENCY_TIMEOUT_MS });
  } else {
    const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
    try {
      const { stdout } = await execFileAsync('xcrun', [
        'simctl',
        'get_app_container',
        udid,
        IOS_BUNDLE_ID,
        'data',
      ]);
      await rm(path.join(stdout.trim(), 'Documents', RESULTS_FILENAME), { force: true });
    } catch {
      // App not installed yet, or no prior results file -- fine either way.
    }
    await execFileAsync('maestro', ['--platform', 'ios', '--udid', udid, 'test', flowPath], {
      timeout: TOUCH_LATENCY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    await awaitAndPullResultsIos({ udid, destPath, timeoutMs: TOUCH_LATENCY_TIMEOUT_MS });
  }

  const json = await readFile(destPath, 'utf8');
  return JSON.parse(json).measurement;
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

  // --- Group 3: rendering pipeline suite (PLAN.md §4 Group 3, H4, H5; ticket T06) ---
  // Every scene's own component picks its default durationMs/warmupMs (see
  // rig/src/scenes/Skia*.tsx, ListScrollScene.tsx, NavTransitionsScene.tsx)
  // -- registry entries below pass no params for those, so the scene's own
  // defaults apply; extractSamples always pulls `samples_ms`, the raw
  // frame-to-frame intervals the shared FrameRecorder produces (rig/src/
  // harness/frameRecorder.ts), so the host-side stats pipeline (summarize())
  // recomputes median/p95/p99/cv over the untouched per-frame samples
  // rather than trusting the scene's own summary numbers blind -- same
  // precedent as every Group 2/5 entry above.

  register({
    id: 'skia.s1.drawcall_storm',
    group: 3,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_frame',
    async run(ctx) {
      return runRigScene('skia.s1.drawcall_storm', {}, ctx, (m) => m.samples_ms);
    },
  });

  register({
    id: 'skia.s2.fillrate',
    group: 3,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_frame',
    async run(ctx) {
      return runRigScene('skia.s2.fillrate', {}, ctx, (m) => m.samples_ms);
    },
  });

  register({
    id: 'skia.s3.texture_churn',
    group: 3,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_frame',
    async run(ctx) {
      return runRigScene('skia.s3.texture_churn', {}, ctx, (m) => m.samples_ms);
    },
  });

  register({
    id: 'skia.s4.vector_text',
    group: 3,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_frame',
    async run(ctx) {
      return runRigScene('skia.s4.vector_text', {}, ctx, (m) => m.samples_ms);
    },
  });

  register({
    id: 'list.scroll',
    group: 3,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_frame',
    async run(ctx) {
      // Params pinned explicitly (matching the scene component's own
      // defaults) so a future change to ListScrollScene.tsx's defaults
      // can't silently change what a registry run measures without this
      // call site's LIST_SCROLL_TIMEOUT_MS being revisited too.
      return runRigScene(
        'list.scroll',
        { durationMs: 60_000 },
        ctx,
        (m) => m.samples_ms,
        LIST_SCROLL_TIMEOUT_MS,
        (m) => {
          // eslint-disable-next-line no-console
          console.log(
            `emu-bench: list.scroll leg ${ctx.leg}: totalScrolledPx=${m.totalScrolledPx} velocityPxPerS=${m.velocityPxPerS}`,
          );
        },
      );
    },
  });

  register({
    id: 'nav.transitions',
    group: 3,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms_per_frame',
    async run(ctx) {
      return runRigScene('nav.transitions', {}, ctx, (m) => m.samples_ms);
    },
  });

  // --- Group 4: input latency, primary (PLAN.md §4 Group 4, H6; ticket T07) ---
  // Unlike every entry above, this scene's `run(ctx)` does not go through
  // `runRigScene`/`runSceneAndGetMeasurement` -- see
  // `runTouchLatencySceneViaMaestro`'s own doc comment for why (taps must
  // be delivered by the same external injector, Maestro, on both legs).

  register({
    id: 'touch.latency',
    group: 4,
    legs: ['b', 'c'],
    kind: 'micro',
    unit: 'ms',
    async run(ctx) {
      if (ctx.leg !== 'b' && ctx.leg !== 'c') {
        throw new Error(`rig-scenes: scene "touch.latency" only supports legs b/c, got "${ctx.leg}"`);
      }
      const measurement = await runTouchLatencySceneViaMaestro(ctx.leg);
      const samples = measurement.samples_ms;
      if (!Array.isArray(samples) || samples.some((s) => typeof s !== 'number')) {
        throw new Error('rig-scenes: scene "touch.latency" did not yield a numeric samples array');
      }
      if (measurement.missedTaps > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `emu-bench: touch.latency leg ${ctx.leg}: ${measurement.notes ?? `${measurement.missedTaps} missed tap(s)`}`,
        );
      }
      return samples;
    },
  });
}
