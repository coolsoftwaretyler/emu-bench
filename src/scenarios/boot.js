// @ts-check
/**
 * Boot scenarios (PLAN.md §4 Group 6, H8; SPEC.md §11; ticket T10 scope).
 * Host-side stopwatch scenarios -- no rig app involved, no leg-A analog
 * (SPEC.md §3: "Groups 6-7 measure the devices themselves ... where a
 * 'native Mac leg' has no meaning"). Registers three BenchmarkEntry ids,
 * each supporting legs b/c only:
 *
 *   - `boot.cold`: full shutdown -> `-no-snapshot-load` (Android) /
 *     `simctl boot` after `simctl shutdown` (iOS) -> poll interactive.
 *     n>=10 each (PLAN.md §5 macro floor), full shutdown between
 *     iterations (ticket scope line 15).
 *   - `boot.warm`: Android quickboot save/resume cycle (default emulator
 *     behavior: no `-no-snapshot-*` flags, so it auto-loads the snapshot
 *     if one exists and auto-saves on exit) vs iOS ordinary boot (no
 *     snapshot concept exists on the simulator -- SPEC.md §11's "warm ...
 *     simulator ordinary boot" and PLAN.md §4's own row documents this as
 *     the finding itself, not a methodology gap).
 *   - `boot.quickboot_reliability`: 10 emulator-only quickboot cycles,
 *     each classified genuine-resume vs silent-cold-boot-fallback (ticket
 *     acceptance: "demonstrably detects a forced cold boot ... the
 *     classifier can't just report 100% genuine"). Verified by a
 *     one-time self-test that runs *before* the measured n=10 sequence:
 *     wipe the snapshot, run one cycle, assert the classifier caught the
 *     resulting forced fallback (throwing loudly if not), then discard
 *     that cycle's timing/classification and reseed before the real
 *     sequence starts -- so the injected fault validates the classifier
 *     without ever landing in `samples` or the genuine/fallback counts
 *     the recorded row reports (see wipeQuickbootSnapshot's own doc, and
 *     the registration block below).
 *
 * Android mechanics: spawn `emulator -avd <name> <flags>`, poll
 * `adb shell getprop sys.boot_completed` until it reads "1", measure
 * elapsed wall time, then fully shut the AVD down (`adb emu kill`) and
 * wait for the process to exit before the next iteration -- this suite
 * always runs a single AVD instance at a time (src/kernels.js's
 * EMULATOR_SERIAL convention: `emulator-5554`).
 *
 * iOS mechanics: `xcrun simctl shutdown <udid>` -> `simctl boot <udid>`
 * -> `simctl bootstatus <udid> -b` (blocks until booted, matching
 * PLAN.md's Phase-0 command precedent in PLAN.md Appendix -- "Phase 0
 * commands").
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { register } from '../registry.js';
import { firstBootedSimulatorUdid } from '../rig-host.js';

const execFileAsync = promisify(execFile);

/** Same single-emulator-instance convention as src/kernels.js/src/fence.js. */
const EMULATOR_SERIAL = 'emulator-5554';
/** Bench AVD used for every boot scenario (SPEC.md §6: the tuned AVD is
 * primary for the full matrix). */
const AVD_NAME = 'bench-tuned';

const BOOT_POLL_INTERVAL_MS = 500;
/** Generous headroom above a true cold boot (observed emulator cold boots
 * on this class of machine run well under a minute; PLAN.md §4 predicts
 * simulator well under emulator). */
const COLD_BOOT_TIMEOUT_MS = 180_000;
const WARM_BOOT_TIMEOUT_MS = 120_000;

/** Ticket scope: "n>=10 unless noted" (PLAN.md §5 macro floor). */
const COLD_BOOT_N = 10;
const WARM_BOOT_N = 10;
const QUICKBOOT_RELIABILITY_N = 10;

/**
 * A resume is classified "genuine" if it completes well under the elapsed
 * time a full cold boot needs (PLAN.md §11: "detected via boot-completed
 * elapsed time threshold and emulator logs"). Set well above typical
 * quickboot-resume time and well below typical cold-boot time so the
 * threshold alone separates the two classes cleanly; the log-text check
 * below is the second, independent signal so the classifier isn't relying
 * on timing noise alone.
 */
const QUICKBOOT_GENUINE_THRESHOLD_MS = 15_000;

/**
 * Emulator/QEMU log text this suite has observed marking a snapshot load
 * failure (falls back to a full cold boot silently from the developer's
 * point of view -- PLAN.md glossary "quickboot": "Can silently fall back
 * to a cold boot; the suite counts those failures"). Checked
 * case-insensitively against the boot process's combined stdout+stderr.
 * If the emulator binary in use never prints any of these (e.g. a
 * successful resume logs neither), their absence is itself consistent
 * with "genuine" -- the elapsed-time threshold is what actually gates
 * classification; this list only lets an explicit failure override a
 * fast-but-lying resume.
 */
const COLD_FALLBACK_LOG_PATTERNS = [
  /fail(?:ed|ure)? to load snapshot/i,
  /unable to load snapshot/i,
  /snapshot .* (?:is )?invalid/i,
  /loading snapshot .* failed/i,
  /falling back to.*cold boot/i,
  /quickboot.*(?:disabled|not available)/i,
];

/**
 * @returns {Promise<string>}
 */
async function resolveIosUdid() {
  const udid = await firstBootedSimulatorUdid();
  if (udid) return udid;
  // No booted device to read from -- boot scenarios manage their own
  // boot/shutdown cycle, so absent any booted device we still need a
  // concrete UDID to shut down/boot repeatedly. Use the newest available
  // iPhone runtime pairing (SPEC.md §6: "newest iPhone device type of the
  // installed newest runtime") by asking simctl for the device list and
  // picking the first iPhone entry under the newest iOS runtime.
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '-j']);
  const parsed = JSON.parse(stdout);
  const iosRuntimeKeys = Object.keys(parsed.devices).filter((k) => k.includes('iOS'));
  iosRuntimeKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const key of iosRuntimeKeys.reverse()) {
    const iphone = parsed.devices[key].find((/** @type {any} */ d) => d.name.includes('iPhone'));
    if (iphone) return iphone.udid;
  }
  throw new Error('boot: no iOS Simulator device found at all (simctl list devices returned none)');
}

/**
 * Spawns the Android emulator with the given extra flags, resolving once
 * `sys.boot_completed` reads "1" (or rejecting on timeout). The caller
 * controls shutdown timing itself afterward (boot.warm's
 * snapshot-save-on-exit behavior depends on *how* the process is asked to
 * quit -- `adb emu kill` triggers the normal graceful shutdown including
 * snapshot auto-save, whereas SIGKILL would not), so this function never
 * kills the process it spawns; see shutdownAndroid().
 * @param {string[]} extraFlags
 * @param {number} timeoutMs
 * @returns {Promise<{ elapsedMs: number, stderr: string }>}
 */
function bootAndroidOnce(extraFlags, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      'emulator',
      ['-avd', AVD_NAME, '-no-window', '-no-audio', ...extraFlags],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderrBuf = '';
    let stdoutBuf = '';
    let settled = false;
    /** @type {NodeJS.Timeout|null} */
    let pollTimer = null;
    /** @type {NodeJS.Timeout|null} */
    let hardTimeout = null;

    const finish = (/** @type {Error|null} */ err, /** @type {number} */ elapsedMs) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      if (err) reject(err);
      else resolve({ elapsedMs, stderr: stderrBuf + '\n' + stdoutBuf });
    };

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.on('error', (err) => finish(err, 0));
    child.on('exit', (code) => {
      if (!settled) {
        finish(
          new Error(
            `boot: emulator exited early (code ${code}) before boot_completed -- stderr tail: ${stderrBuf.slice(-2000)}`,
          ),
          0,
        );
      }
    });

    pollTimer = setInterval(async () => {
      try {
        const { stdout } = await execFileAsync('adb', [
          '-s',
          EMULATOR_SERIAL,
          'shell',
          'getprop',
          'sys.boot_completed',
        ]);
        if (stdout.trim() === '1') {
          finish(null, Date.now() - startedAt);
        }
      } catch {
        // adb not reachable yet -- keep polling.
      }
    }, BOOT_POLL_INTERVAL_MS);

    hardTimeout = setTimeout(() => {
      finish(new Error(`boot: did not reach boot_completed within ${timeoutMs}ms`), 0);
    }, timeoutMs);
  });
}

/**
 * Ensures `emulator-5554` is present in `adb devices`, booting
 * `bench-tuned` (ordinary quickboot-eligible boot, not forced cold) if
 * it isn't -- discovered as a real gap during this ticket's own
 * verification: `boot.cold`/`boot.warm`/`boot.quickboot_reliability` all
 * legitimately end with the emulator shut down (that is what "full
 * shutdown between iterations" means), but nothing else in a single
 * `--groups 6` invocation ever booted it back up again before
 * install/transfer/refresh/tti scenarios ran, so those scenarios found no
 * emulator device at all. Every other Group 6 scenario module
 * (install.js, transfer.js, refresh.js, tti.js) calls this before
 * resolving an Android device serial, so `--groups 6` succeeds
 * end-to-end regardless of execution order within the group.
 *
 * Gotcha for future callers that need a *live* Metro connection (this
 * function's own boot does not set one up): a fresh emulator process --
 * which is what this function produces when the emulator was down --
 * carries no `adb reverse` port mappings even though it keeps the same
 * serial; those mappings are per-adb-connection-to-that-process and do
 * not survive a shutdown+reboot cycle. src/scenarios/refresh.js hit this
 * directly (its debug build's very first Metro bundle fetch silently
 * had no path to the dev server) and re-establishes
 * `adb reverse tcp:8081 tcp:8081` itself right after installing its
 * debug build. Any scenario relying on a running Metro instance at
 * runtime (not just at build/bundle time) needs to do the same rather
 * than assuming a mapping set up once at the start of a `run` survives
 * every boot scenario that runs before it.
 * @returns {Promise<void>}
 */
export async function ensureEmulatorRunning() {
  const { stdout } = await execFileAsync('adb', ['devices']);
  const alreadyUp = stdout
    .split('\n')
    .slice(1)
    .some((line) => {
      const [serial, state] = line.trim().split(/\s+/);
      return serial?.startsWith('emulator-') && state === 'device';
    });
  if (alreadyUp) return;
  await bootAndroidOnce(['-no-boot-anim'], WARM_BOOT_TIMEOUT_MS);
}

/**
 * Gracefully shuts the currently-running AVD down via `adb emu kill` (the
 * path that triggers quickboot's normal snapshot auto-save on exit,
 * unlike SIGKILL) and waits for the emulator process to fully disappear
 * from `adb devices` before returning, so the next boot iteration starts
 * from a clean slate.
 * @returns {Promise<void>}
 */
async function shutdownAndroid() {
  try {
    await execFileAsync('adb', ['-s', EMULATOR_SERIAL, 'emu', 'kill']);
  } catch {
    // Already gone -- fine.
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync('adb', ['devices']);
    if (!stdout.includes(EMULATOR_SERIAL)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('boot: emulator did not shut down within 30s of `adb emu kill`');
}

/**
 * Full shutdown -> forced cold boot -> measure elapsed-to-interactive.
 * @returns {Promise<number>} elapsed ms
 */
async function coldBootAndroidOnce() {
  await shutdownAndroid();
  const { elapsedMs } = await bootAndroidOnce(
    ['-no-snapshot-load', '-no-boot-anim'],
    COLD_BOOT_TIMEOUT_MS,
  );
  return elapsedMs;
}

/**
 * @param {string} udid
 * @returns {Promise<number>} elapsed ms for `simctl boot` + `bootstatus -b`
 *   after a full `simctl shutdown` -- SPEC.md §11 / PLAN.md §4's iOS cold
 *   boot method.
 */
async function coldBootIosOnce(udid) {
  await execFileAsync('xcrun', ['simctl', 'shutdown', udid]).catch(() => {});
  const startedAt = Date.now();
  await execFileAsync('xcrun', ['simctl', 'boot', udid]);
  await execFileAsync('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
    timeout: COLD_BOOT_TIMEOUT_MS,
  });
  return Date.now() - startedAt;
}

/**
 * Classifies one quickboot cycle: boots without `-no-snapshot-load` (so it
 * attempts a resume if a snapshot exists), measures elapsed time, and
 * checks the process's own log output for an explicit fallback signal.
 * @returns {Promise<{ elapsedMs: number, genuine: boolean, sawFallbackLog: boolean }>}
 */
async function quickbootCycleOnce() {
  const { elapsedMs, stderr } = await bootAndroidOnce(['-no-boot-anim'], WARM_BOOT_TIMEOUT_MS);
  const sawFallbackLog = COLD_FALLBACK_LOG_PATTERNS.some((re) => re.test(stderr));
  const genuine = !sawFallbackLog && elapsedMs < QUICKBOOT_GENUINE_THRESHOLD_MS;
  await shutdownAndroid();
  return { elapsedMs, genuine, sawFallbackLog };
}

/**
 * Deletes the AVD's quickboot snapshot on disk, forcing the *next* boot
 * attempt to silently fall back to a full cold boot even though it is
 * launched exactly like every genuine "resume" attempt elsewhere in this
 * scenario (ticket acceptance criterion 2: "test by wiping snapshots
 * mid-sequence once"). This is the fault-injection the ticket requires
 * so the reliability classifier's "not just 100% genuine" claim is
 * actually exercised, not asserted -- used by `boot.quickboot_reliability`
 * as a one-time self-test *before* the measured n=10 sequence, not mixed
 * into it (see that registration block's own doc comment for why: an
 * earlier version ran this inline mid-sequence, which put the forced
 * cycle's own timing and fallback classification into the recorded
 * `samples`/counts, poisoning every run's data with a harness-
 * manufactured failure PLAN.md's "natural silent-fallback rate" metric
 * was never meant to include).
 * @returns {Promise<void>}
 */
async function wipeQuickbootSnapshot() {
  const home = process.env.HOME ?? '';
  const { rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const snapshotDir = path.join(home, '.android', 'avd', `${AVD_NAME}.avd`, 'snapshots', 'default_boot');
  await rm(snapshotDir, { recursive: true, force: true });
}

/**
 * Registers `boot.cold`, `boot.warm`, and `boot.quickboot_reliability`
 * (PLAN.md §4 Group 6). Called as a side effect of importing this module
 * from run.js, matching src/kernels.js's `registerKernelBenchmarks()` /
 * src/fence.js's `registerFenceBenchmarks()` precedent -- kept as an
 * explicit exported function rather than top-level side effects so
 * run.js's import remains an explicit, greppable call site.
 */
export function registerBootBenchmarks() {
  // --- boot.cold -----------------------------------------------------------

  register({
    id: 'boot.cold',
    group: 6,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 's',
    async run(ctx) {
      if (ctx.leg === 'b') {
        /** @type {number[]} */
        const samples = [];
        for (let i = 0; i < COLD_BOOT_N; i++) {
          const elapsedMs = await coldBootAndroidOnce();
          samples.push(elapsedMs / 1000);
        }
        await shutdownAndroid();
        return samples;
      }
      if (ctx.leg === 'c') {
        const udid = await resolveIosUdid();
        /** @type {number[]} */
        const samples = [];
        for (let i = 0; i < COLD_BOOT_N; i++) {
          const elapsedMs = await coldBootIosOnce(udid);
          samples.push(elapsedMs / 1000);
        }
        return samples;
      }
      throw new Error(`boot.cold: unsupported leg "${ctx.leg}"`);
    },
  });

  // --- boot.warm -------------------------------------------------------------

  register({
    id: 'boot.warm',
    group: 6,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 's',
    async run(ctx) {
      if (ctx.leg === 'b') {
        // First establish a snapshot to resume from: one full cold boot,
        // then a graceful shutdown (which auto-saves quickboot state).
        await coldBootAndroidOnce();
        await shutdownAndroid();

        /** @type {number[]} */
        const samples = [];
        for (let i = 0; i < WARM_BOOT_N; i++) {
          // No -no-snapshot-* flags: default behavior auto-loads the
          // snapshot if present (SPEC.md §11 "warm (quickboot resume)").
          const { elapsedMs } = await bootAndroidOnce(['-no-boot-anim'], WARM_BOOT_TIMEOUT_MS);
          samples.push(elapsedMs / 1000);
          await shutdownAndroid();
        }
        return samples;
      }
      if (ctx.leg === 'c') {
        // "Simulator ordinary boot (it has no snapshot concept -- that
        // asymmetry is the finding; document in scenario notes)" -- ticket
        // scope line 16. There is no warm-resume mechanism to invoke, so
        // this measures the same shutdown->boot->bootstatus cycle as
        // boot.cold; the two rows being numerically close (rather than
        // showing a warm-path speedup the way Android's does) *is* the
        // documented finding, not a bug in this scenario.
        const udid = await resolveIosUdid();
        /** @type {number[]} */
        const samples = [];
        for (let i = 0; i < WARM_BOOT_N; i++) {
          const elapsedMs = await coldBootIosOnce(udid);
          samples.push(elapsedMs / 1000);
        }
        return samples;
      }
      throw new Error(`boot.warm: unsupported leg "${ctx.leg}"`);
    },
  });

  // --- boot.quickboot_reliability --------------------------------------------

  register({
    id: 'boot.quickboot_reliability',
    group: 6,
    legs: ['b'],
    kind: 'macro',
    unit: 's',
    async run() {
      // Seed a snapshot to resume from, matching boot.warm's own setup.
      await coldBootAndroidOnce();
      await shutdownAndroid();

      // A one-time, self-test cycle that runs *before* the measured
      // sequence and is never mixed into it (reviewer finding: the
      // injected wipe previously ran inline at the sequence's midpoint,
      // so its forced ~44s cold boot landed in `samples` and its
      // fallback classification landed in `fallbackCount` -- poisoning
      // every run's recorded data with a harness-manufactured failure
      // and putting a permanent floor of 1/N under the reported rate.
      // PLAN.md lines 149/159/285 make quickboot's *natural* silent-
      // fallback rate the metric; ticket acceptance criterion 2 only
      // requires proving the classifier *can* catch a forced fallback,
      // not that every run's data include one). This self-test wipes the
      // snapshot, runs one quickboot cycle, asserts it was classified as
      // a fallback (throwing loudly otherwise -- the guard criterion 2
      // asks for), then discards that cycle's timing and classification
      // entirely before the real n=10 sequence begins on a freshly
      // reseeded snapshot.
      await wipeQuickbootSnapshot();
      const selfTest = await quickbootCycleOnce();
      if (selfTest.genuine) {
        throw new Error(
          `boot.quickboot_reliability: self-test wiped the snapshot but the classifier still reported the resulting cold boot as genuine (elapsedMs=${selfTest.elapsedMs}) -- classifier is not detecting fallbacks`,
        );
      }
      // The self-test cycle's own graceful shutdown (inside
      // quickbootCycleOnce) re-creates a snapshot from its cold boot, but
      // reseed explicitly anyway so the measured sequence's iteration 0
      // starts from the exact same known-good state as every other
      // iteration, independent of that implementation detail.
      await coldBootAndroidOnce();
      await shutdownAndroid();

      /** @type {number[]} */
      const samples = [];
      let genuineCount = 0;
      let fallbackCount = 0;

      for (let i = 0; i < QUICKBOOT_RELIABILITY_N; i++) {
        const { elapsedMs, genuine } = await quickbootCycleOnce();
        samples.push(elapsedMs / 1000);
        if (genuine) genuineCount++;
        else fallbackCount++;
      }

      const failureRate = fallbackCount / QUICKBOOT_RELIABILITY_N;
      // eslint-disable-next-line no-console
      console.log(
        `emu-bench: boot.quickboot_reliability: self-test fault injection correctly classified as fallback (excluded from samples/counts below); ${genuineCount}/${QUICKBOOT_RELIABILITY_N} genuine, ${fallbackCount}/${QUICKBOOT_RELIABILITY_N} fallback (failure rate ${(failureRate * 100).toFixed(1)}%)`,
      );
      return samples;
    },
  });
}

export {
  bootAndroidOnce,
  shutdownAndroid,
  coldBootAndroidOnce,
  coldBootIosOnce,
  quickbootCycleOnce,
  wipeQuickbootSnapshot,
  COLD_FALLBACK_LOG_PATTERNS,
  QUICKBOOT_GENUINE_THRESHOLD_MS,
};
