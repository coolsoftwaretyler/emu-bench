// @ts-check
/**
 * App startup TTI scenario (PLAN.md §4 Group 6, H8; SPEC.md §11; ticket
 * T10 scope). "n>=10 cold app launches using T04's marker; Android
 * cross-check with `am start -W` TotalTime recorded alongside." Drives
 * the rig's existing `startup.tti` scene (T04; rig/src/scenes/
 * StartupTtiScene.tsx + rig/src/harness/startupMarker.ts) via the same
 * host extraction helpers every other rig scene uses (src/rig-host.js),
 * but forces a cold app process before each launch (force-stop on
 * Android, terminate+re-launch on iOS) so every sample is a genuine cold
 * TTI, not a warm relaunch of an already-running process.
 *
 * Registers one BenchmarkEntry, `startup.tti`, legs b/c, unit ms --
 * samples are the scene's own `ttiMs` (native-process-start ->
 * first-meaningful-render delta, T04's marker). The Android leg
 * additionally records `am start -W` TotalTime per iteration as a
 * cross-check and logs it alongside (ticket's own acceptance: "TTI
 * markers agree with `am start -W` within noise" -- SPEC.md §11 /
 * PLAN.md §4 both call for this cross-check explicitly), rather than
 * folding it into the same samples array (mixing two different measures
 * -- the JS marker delta vs. ActivityManager's own launch-to-first-frame
 * timer -- into one statistics pipeline would make the recorded
 * median/p95 ambiguous about which metric they summarize).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { register } from '../registry.js';
import {
  ANDROID_APP_ID,
  IOS_BUNDLE_ID,
  RESULTS_FILENAME,
  awaitAndPullResultsAndroid,
  awaitAndPullResultsIos,
  buildSceneUrl,
  ensureAdbRoot,
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
} from '../rig-host.js';
import { ensureEmulatorRunning } from './boot.js';

const execFileAsync = promisify(execFile);

const scratchDir = fileURLToPath(new URL('../../results/.scratch/', import.meta.url));

/** Ticket scope: "n>=10" (PLAN.md §5 macro floor). Floor+2 (12), not a
 * bare 10 -- T13's orchestrator discards 2 warmup samples uniformly
 * (PLAN.md §5, SPEC.md §12), so an entry sized at exactly the floor would
 * report n=8 after discarding. Discovered as a real T13 integration bug
 * during this ticket's own rehearsal run. */
const TTI_N = 12;
const EXTRACTION_TIMEOUT_MS = 30_000;

/**
 * Resolves the Android target device, refusing to silently fall back to
 * a real physical device the way `firstAndroidDeviceSerial()` alone would
 * (real devices are an explicit non-goal, SPEC.md §3) -- discovered
 * during this ticket's own verification run: a physical Pixel 6a happened
 * to be attached over adb-tls alongside the emulator, and once a prior
 * boot scenario in the same `run` left the emulator shut down (boot.cold/
 * boot.warm/boot.quickboot_reliability all legitimately end with the
 * emulator off -- that's what "full shutdown between iterations" means),
 * `firstAndroidDeviceSerial()`'s `?? serials[0]` fallback would silently
 * target the physical phone instead of failing loudly.
 * @param {string|null} [config] RunContext's `config` field (T13: threaded
 *   through to ensureEmulatorRunning so startup.tti boots the
 *   config-appropriate AVD rather than always the tuned one).
 * @returns {Promise<string>}
 */
async function resolveEmulatorSerial(config) {
  await ensureEmulatorRunning(config);
  const serial = await firstAndroidDeviceSerial();
  if (serial && serial.startsWith('emulator-')) return serial;
  throw new Error(
    `startup.tti: no Android emulator device found in \`adb devices\` after ensureEmulatorRunning() (got "${serial ?? 'none'}") -- ` +
      `a non-emulator device must never be silently substituted (SPEC.md §3 non-goals: real devices).`,
  );
}

/**
 * Force-stops the rig on Android, launches it via `am start -W` straight
 * into `startup.tti` (a cold process every time, since force-stop just
 * preceded it), and returns the ActivityManager-reported TotalTime
 * (SPEC.md §11 / PLAN.md §4's Android cross-check).
 * @param {string} serial
 * @returns {Promise<number>} TotalTime in ms, parsed from `am start -W`'s output
 */
async function coldLaunchAndroidWithAmStartW(serial) {
  await execFileAsync('adb', ['-s', serial, 'shell', 'am', 'force-stop', ANDROID_APP_ID]);
  const remotePath = `/data/data/${ANDROID_APP_ID}/files/${RESULTS_FILENAME}`;
  await execFileAsync('adb', ['-s', serial, 'shell', 'rm', '-f', remotePath]).catch(() => {});

  const url = buildSceneUrl('startup.tti', {});
  const { stdout } = await execFileAsync('adb', [
    '-s',
    serial,
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    url,
  ]);
  const match = stdout.match(/TotalTime:\s*(\d+)/);
  if (!match) {
    throw new Error(`startup.tti: could not parse TotalTime from am start -W output:\n${stdout}`);
  }
  return Number(match[1]);
}

/**
 * Force-terminates the rig on iOS (`simctl terminate`) then opens the
 * `startup.tti` deep link, guaranteeing a cold process launch every
 * iteration the same way the Android path does via force-stop. No
 * `am start -W`-equivalent TotalTime exists on iOS (SPEC.md §11 only
 * specifies the cross-check "on Android"), so this returns nothing beyond
 * triggering the launch.
 * @param {string} udid
 * @returns {Promise<void>}
 */
async function coldLaunchIos(udid) {
  await execFileAsync('xcrun', ['simctl', 'terminate', udid, IOS_BUNDLE_ID]).catch(() => {});
  try {
    const { stdout } = await execFileAsync('xcrun', [
      'simctl',
      'get_app_container',
      udid,
      IOS_BUNDLE_ID,
      'data',
    ]);
    const resultsPath = path.join(stdout.trim(), 'Documents', RESULTS_FILENAME);
    const { rm } = await import('node:fs/promises');
    await rm(resultsPath, { force: true });
  } catch {
    // App not installed yet, or no prior results file -- fine either way.
  }
  const url = buildSceneUrl('startup.tti', {});
  await execFileAsync('xcrun', ['simctl', 'openurl', udid, url]);
}

/**
 * Registers `startup.tti` (PLAN.md §4 Group 6). Called as a side effect
 * of importing this module from run.js, matching src/kernels.js's
 * `registerKernelBenchmarks()` precedent.
 */
export function registerTtiBenchmarks() {
  register({
    id: 'startup.tti',
    group: 6,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms',
    async run(ctx) {
      if (ctx.leg === 'b') {
        const serial = await resolveEmulatorSerial(ctx.config);
        await ensureAdbRoot({ serial });
        /** @type {number[]} */
        const samples = [];
        /** @type {number[]} */
        const amStartWTotalTimesMs = [];

        for (let i = 0; i < TTI_N; i++) {
          const totalTimeMs = await coldLaunchAndroidWithAmStartW(serial);
          amStartWTotalTimesMs.push(totalTimeMs);
          const destPath = path.join(scratchDir, `startup-tti-crosscheck-leg-b-${i}.local.json`);
          await awaitAndPullResultsAndroid({ serial, destPath, timeoutMs: EXTRACTION_TIMEOUT_MS });
          const parsed = JSON.parse(await readFile(destPath, 'utf8'));
          samples.push(parsed.measurement.ttiMs);
        }

        // Ticket's own acceptance: "Android cross-check with `am start -W`
        // TotalTime recorded alongside" -- logged rather than folded into
        // the returned samples (see module doc comment for why).
        const medianTti = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
        const medianAmStartW = [...amStartWTotalTimesMs].sort((a, b) => a - b)[
          Math.floor(amStartWTotalTimesMs.length / 2)
        ];
        // eslint-disable-next-line no-console
        console.log(
          `emu-bench: startup.tti leg b: median JS-marker ttiMs=${medianTti.toFixed(1)}, median am-start-W TotalTime=${medianAmStartW}ms (am start -W samples: ${JSON.stringify(amStartWTotalTimesMs)})`,
        );

        return samples;
      }

      if (ctx.leg === 'c') {
        const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
        /** @type {number[]} */
        const samples = [];

        for (let i = 0; i < TTI_N; i++) {
          await coldLaunchIos(udid);
          const destPath = path.join(scratchDir, `startup-tti-crosscheck-leg-c-${i}.local.json`);
          await awaitAndPullResultsIos({ udid, destPath, timeoutMs: EXTRACTION_TIMEOUT_MS });
          const parsed = JSON.parse(await readFile(destPath, 'utf8'));
          samples.push(parsed.measurement.ttiMs);
        }

        return samples;
      }

      throw new Error(`startup.tti: unsupported leg "${ctx.leg}"`);
    },
  });
}
