// @ts-check
/**
 * Maestro E2E + flake-rate scenario (PLAN.md §4 Group 6 "E2E flow" row, H8;
 * SPEC.md §11; ticket T11 scope). "One identical Maestro flow (launch ->
 * form fill -> scroll -> navigate -> assert): duration, plus flake rate
 * over 50 runs. CI throughput = duration x (1 + flake rate)." Drives
 * `flows/e2e.yaml` (one YAML, both platforms, platform conditionals only
 * in launch/app-id stanzas -- ticket acceptance criterion 2; that file's
 * own header explains why it needs none at all here) via
 * `maestro test flows/e2e.yaml`, targeted at whichever single leg-b/leg-c
 * device is currently booted (this suite runs one AVD instance and one
 * simulator at a time, matching every other Group 6 module's convention --
 * src/scenarios/boot.js's EMULATOR_SERIAL comment, etc.).
 *
 * Registers two BenchmarkEntry ids, both legs b/c:
 *
 *   - `e2e.duration`: n>=10 timed executions (PLAN.md §5 macro floor),
 *     cold app process forced before each run (force-stop on Android,
 *     terminate on iOS -- "cold app start each time, device already
 *     booted" per ticket scope; booting itself is T10's metric, not
 *     this one's).
 *   - `e2e.flake_rate`: n runs (default 10, override via `--flake-runs N`
 *     -- ticket acceptance criterion 4: "50-run mode is behind a flag
 *     since it's slow"; `run.js` threads `flags.flakeRuns` into
 *     `ctx.flakeRuns`), each classified:
 *       - **pass**: `maestro test` exits 0.
 *       - **fail-flake**: exits non-zero, but an immediate retry of the
 *         *same* flow (same cold-launch precondition re-applied) passes.
 *       - **fail-real**: exits non-zero on both the original attempt and
 *         the immediate retry.
 *     Reported as one sample series (duration_s per *original* attempt,
 *     pass or fail alike is timed) plus a flake-rate summary logged to
 *     stdout (matching src/scenarios/boot.js's
 *     `boot.quickboot_reliability` genuine/fallback logging precedent,
 *     since the results schema, SPEC.md §7, has no dedicated field for a
 *     pass/fail-flake/fail-real breakdown). Per-iteration Maestro debug
 *     output (stdout+stderr) for every FAILED attempt (both the original
 *     and, when it happens, the retry) is written under `results/logs/`
 *     (gitignored -- ticket scope: "Persist per-iteration logs for failed
 *     runs under `results/logs/`") so a real failure can be diagnosed after
 *     the fact instead of only ever seeing a bare pass/fail count.
 *
 * `e2e.duration`'s samples are always the *first*-attempt wall-clock
 * duration regardless of pass/fail (a flow that's about to fail still
 * spends real wall-clock time doing so, and excluding failed attempts from
 * the duration series would bias it toward only the fast, trouble-free
 * runs) -- consistent with "CI throughput = duration x (1 + flake rate)"
 * treating duration and flake rate as two independently-reported numbers
 * that combine into one meaning, not one number that already excludes the
 * other's effect.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { register } from '../registry.js';
import {
  ANDROID_APP_ID,
  IOS_BUNDLE_ID,
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
} from '../rig-host.js';
import { ensureEmulatorRunning } from './boot.js';

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const flowPath = path.join(repoRoot, 'flows/e2e.yaml');
const logsDir = path.join(repoRoot, 'results/logs/');

/** Ticket scope: "n>=10 timed executions per platform" (PLAN.md §5 macro floor). */
// Floor+2 (12), not a bare 10 -- T13's orchestrator discards 2 warmup
// samples uniformly (PLAN.md §5, SPEC.md §12), so an entry sized at
// exactly the floor would report n=8 after discarding. Discovered as a
// real T13 integration bug during this ticket's own rehearsal run.
const DURATION_N = 12;
/** Modest no-flag default (matches the ticket's own verification command,
 * `--flake-runs 10`) -- the full "50 executions per platform" scope (PLAN.md
 * §4 / SPEC.md §11) is deliberately opt-in via `--flake-runs 50` (ticket
 * acceptance criterion 4: "50-run mode is behind a flag ... since it's
 * slow"), not the value a plain `--groups 6` pays for automatically. See
 * ctx.flakeRuns below. Floor+2 (12), not a bare 10, for the same
 * warmup-discard headroom reason as DURATION_N above -- an explicit
 * `--flake-runs 50` override already has ample headroom and is left
 * untouched (a user-supplied n is never silently altered). */
const DEFAULT_FLAKE_RUNS = 12;
/** Generous headroom above this flow's observed ~10-20s real duration on
 * this machine (manual runs during this ticket's implementation) --
 * matches every other Group 6 scenario's "generous, not tuned to the
 * observed number" timeout convention. */
const MAESTRO_TIMEOUT_MS = 120_000;

/**
 * Resolves the Android target device, refusing to silently fall back to a
 * real physical device the way `firstAndroidDeviceSerial()` alone would
 * (real devices are an explicit non-goal, SPEC.md §3) -- same guard every
 * other T10/T11 Group 6 module applies (src/scenarios/boot.js,
 * install.js, transfer.js, refresh.js, tti.js) after discovering, during
 * T10's own verification, that a physical Pixel 6a attached over adb-tls
 * could otherwise be silently targeted once a preceding boot scenario left
 * the emulator down.
 * @param {string|null} [config] RunContext's `config` field (T13: threaded
 *   through to ensureEmulatorRunning so e2e boots the config-appropriate
 *   AVD rather than always the tuned one).
 * @returns {Promise<string>}
 */
async function resolveEmulatorSerial(config) {
  await ensureEmulatorRunning(config);
  const serial = await firstAndroidDeviceSerial();
  if (serial && serial.startsWith('emulator-')) return serial;
  throw new Error(
    `e2e: no Android emulator device found in \`adb devices\` after ensureEmulatorRunning() (got "${serial ?? 'none'}") -- ` +
      `a non-emulator device must never be silently substituted (SPEC.md §3 non-goals: real devices).`,
  );
}

/**
 * Forces a cold app process before the next launch: force-stop on Android,
 * terminate on iOS (ticket scope: "cold app start each time, device
 * already booted"). Mirrors src/scenarios/tti.js's coldLaunchAndroidWithAmStartW
 * / coldLaunchIos precedent -- force-stop/terminate immediately before the
 * *next* launch, not a separate standalone step.
 * @param {{leg: 'b'|'c', serial?: string, udid?: string}} args
 * @returns {Promise<void>}
 */
async function forceColdAppProcess({ leg, serial, udid }) {
  if (leg === 'b') {
    await execFileAsync('adb', ['-s', /** @type {string} */ (serial), 'shell', 'am', 'force-stop', ANDROID_APP_ID]);
  } else {
    await execFileAsync('xcrun', ['simctl', 'terminate', /** @type {string} */ (udid), IOS_BUNDLE_ID]).catch(
      () => {},
    ); // "already not running" is not an error here.
  }
}

/**
 * Runs `maestro test flows/e2e.yaml` once against the given leg's device,
 * targeted explicitly (`-p android` / `--udid <udid>`) so Maestro's own
 * device auto-selection can never silently pick the wrong platform when
 * both an emulator and a simulator happen to be booted simultaneously --
 * confirmed as a real ambiguity during this ticket's implementation: with
 * both devices booted, an untargeted `maestro test` picked the Android
 * emulator by default with no indication it could have picked either.
 * @param {{leg: 'b'|'c', udid?: string}} args
 * @returns {Promise<{ passed: boolean, durationS: number, output: string }>}
 */
async function runMaestroOnce({ leg, udid }) {
  const args =
    leg === 'b'
      ? ['-p', 'android', 'test', flowPath]
      : ['--udid', /** @type {string} */ (udid), 'test', flowPath];
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('maestro', args, {
      timeout: MAESTRO_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { passed: true, durationS: (Date.now() - startedAt) / 1000, output: stdout + stderr };
  } catch (/** @type {any} */ err) {
    const output = `${err?.stdout ?? ''}${err?.stderr ?? ''}` || String(err?.message ?? err);
    return { passed: false, durationS: (Date.now() - startedAt) / 1000, output };
  }
}

/**
 * Writes one failed attempt's Maestro output under `results/logs/`
 * (gitignored -- ticket scope) so a real failure can be diagnosed after
 * the fact.
 * @param {{leg: 'b'|'c', benchmarkId: string, iteration: number, attempt: 'original'|'retry', output: string}} args
 * @returns {Promise<string>}
 */
async function persistFailureLog({ leg, benchmarkId, iteration, attempt, output }) {
  await mkdir(logsDir, { recursive: true });
  const filename = `${benchmarkId}-leg-${leg}-iter${iteration}-${attempt}-${Date.now()}.log`;
  const destPath = path.join(logsDir, filename);
  await writeFile(destPath, output, 'utf8');
  return destPath;
}

/**
 * Registers `e2e.duration` and `e2e.flake_rate` (PLAN.md §4 Group 6).
 * Called as a side effect of importing this module from run.js, matching
 * src/kernels.js's `registerKernelBenchmarks()` precedent.
 */
export function registerE2eBenchmarks() {
  register({
    id: 'e2e.duration',
    group: 6,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 's',
    async run(ctx) {
      if (ctx.leg !== 'b' && ctx.leg !== 'c') {
        throw new Error(`e2e.duration: unsupported leg "${ctx.leg}"`);
      }
      const serial = ctx.leg === 'b' ? await resolveEmulatorSerial(ctx.config) : undefined;
      const udid = ctx.leg === 'c' ? ((await firstBootedSimulatorUdid()) ?? 'booted') : undefined;

      /** @type {number[]} */
      const samples = [];
      let failCount = 0;

      for (let i = 0; i < DURATION_N; i++) {
        await forceColdAppProcess({ leg: ctx.leg, serial, udid });
        const { passed, durationS, output } = await runMaestroOnce({ leg: ctx.leg, udid });
        samples.push(durationS);
        if (!passed) {
          failCount++;
          await persistFailureLog({
            leg: ctx.leg,
            benchmarkId: 'e2e.duration',
            iteration: i,
            attempt: 'original',
            output,
          });
        }
      }

      if (failCount > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `emu-bench: e2e.duration leg ${ctx.leg}: ${failCount}/${DURATION_N} run(s) failed (still timed and included in samples -- see module doc; failure logs under results/logs/).`,
        );
      }

      return samples;
    },
  });

  register({
    id: 'e2e.flake_rate',
    group: 6,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 's',
    async run(ctx) {
      if (ctx.leg !== 'b' && ctx.leg !== 'c') {
        throw new Error(`e2e.flake_rate: unsupported leg "${ctx.leg}"`);
      }
      // Ticket acceptance criterion 4: "50-run mode is behind a flag
      // (--flake-runs 50) since it's slow" -- run.js threads
      // flags.flakeRuns through RunContext; the no-flag default is the
      // modest DEFAULT_FLAKE_RUNS (10), so a plain `--groups 6` never
      // silently pays for the full ~50-run/leg sweep (at this flow's
      // observed ~35-40s/run, that's over an hour across both legs) --
      // the full "50 executions per platform" scope is reached only by
      // explicitly passing `--flake-runs 50`.
      const n = ctx.flakeRuns ?? DEFAULT_FLAKE_RUNS;

      const serial = ctx.leg === 'b' ? await resolveEmulatorSerial(ctx.config) : undefined;
      const udid = ctx.leg === 'c' ? ((await firstBootedSimulatorUdid()) ?? 'booted') : undefined;

      /** @type {number[]} */
      const samples = [];
      let passCount = 0;
      let flakeCount = 0;
      let realFailCount = 0;

      for (let i = 0; i < n; i++) {
        await forceColdAppProcess({ leg: ctx.leg, serial, udid });
        const original = await runMaestroOnce({ leg: ctx.leg, udid });
        samples.push(original.durationS);

        if (original.passed) {
          passCount++;
          continue;
        }

        await persistFailureLog({
          leg: ctx.leg,
          benchmarkId: 'e2e.flake_rate',
          iteration: i,
          attempt: 'original',
          output: original.output,
        });

        // Classify: an immediate retry (same cold-launch precondition
        // re-applied, ticket acceptance criterion 3: "distinguishes
        // retry-passes from real failures") that passes marks this
        // iteration fail-flake; a retry that also fails marks it
        // fail-real.
        await forceColdAppProcess({ leg: ctx.leg, serial, udid });
        const retry = await runMaestroOnce({ leg: ctx.leg, udid });
        if (retry.passed) {
          flakeCount++;
        } else {
          realFailCount++;
          await persistFailureLog({
            leg: ctx.leg,
            benchmarkId: 'e2e.flake_rate',
            iteration: i,
            attempt: 'retry',
            output: retry.output,
          });
        }
      }

      const flakeRate = flakeCount / n;
      const realFailRate = realFailCount / n;
      // eslint-disable-next-line no-console
      console.log(
        `emu-bench: e2e.flake_rate leg ${ctx.leg}: ${passCount}/${n} pass, ${flakeCount}/${n} fail-flake (retry passed), ${realFailCount}/${n} fail-real (retry also failed) -- flake rate ${(flakeRate * 100).toFixed(1)}%, real failure rate ${(realFailRate * 100).toFixed(1)}%. CI throughput = duration x (1 + flake rate) per PLAN.md §4.`,
      );

      return samples;
    },
  });
}
