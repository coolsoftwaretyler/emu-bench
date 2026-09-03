// @ts-check
/**
 * Metro fast-refresh scenario (PLAN.md §4 Group 6, H8; SPEC.md §11;
 * ticket T10 scope). "Script appends a marker string to a source file;
 * app logs when the marker renders; measure the delta. n=20. Dev-mode
 * build, both platforms." -- the "save a file -> see the change" loop,
 * timed.
 *
 * Registers one BenchmarkEntry, `refresh.metro`, legs b/c, unit ms.
 *
 * Mechanism (confirmed against real dev-mode builds + a live Metro
 * instance during this ticket's implementation): the rig's
 * `refresh.marker` scene (rig/src/scenes/RefreshMarkerScene.tsx) renders
 * a module-level string constant, `MARKER_VALUE`, and on every render --
 * both the initial mount AND every Fast-Refresh-triggered re-render
 * (Fast Refresh re-executes the changed module's body, which
 * re-registers/re-renders the component) -- writes a small sentinel
 * file, `<documents>/refresh-marker.local.txt`, containing the current
 * value, via the same native `ResultsFile.writeFile` module every other
 * scene's results writer uses. This driver:
 *
 *   1. Rewrites `MARKER_VALUE`'s quoted literal in place (plain text
 *      replace, the same edit a developer would make by hand), timing
 *      the write.
 *   2. Polls the device's copy of that sentinel file (Android:
 *      `adb shell cat` against the app's files dir; iOS: reading the
 *      file directly out of the simulator's shared-filesystem app
 *      container) until its contents match the *new* value.
 *   3. Records the elapsed ms from write to that match.
 *   4. Repeats n=20 (ticket scope), a fresh unique marker value each
 *      iteration so a stale file read mid-write, or a slow poll tick
 *      that catches a leftover previous value, can never be mistaken for
 *      the current iteration's own signal.
 *
 * File polling, not log streaming, is the mechanism actually used here:
 * an initial design tailed `adb logcat` (Android) / `simctl ... log
 * stream` (iOS) for a `console.log`-sourced line, and while that worked
 * cleanly on Android (confirmed: `ReactNativeJS` tag, exact line format
 * `'EMUBENCH_REFRESH_MARKER', '<value>'`), the same approach found
 * nothing at all on iOS after an extensive empirical check (a full
 * `log stream --level debug` capture scoped to the RigApp process,
 * spanning a real scene mount + marker render, contained zero trace of
 * the JS console.log call -- this RN version's iOS console
 * interception, under New Architecture/Bridgeless, evidently doesn't
 * route through Apple's unified logging system the way Android's does
 * through logcat). File polling reuses the same "read a file back out of
 * the app's documents dir" mechanics every other scene already relies on
 * (src/rig-host.js), rather than depending on a per-platform log
 * transport that only demonstrably works on one of the two platforms
 * this scenario must run on identically.
 *
 * Git-clean guarantee (ticket acceptance criterion 3: "leaves the working
 * tree clean (`git status` unchanged) after every run, including on
 * failure (trap/cleanup)"): the original file content is read once before
 * any mutation and restored in a `finally` block wrapping the entire
 * n=20 loop, so a thrown error mid-loop (a timeout, a device
 * disconnect) still restores the file before the error propagates.
 *
 * Self-provisioning (unlike src/rig-scenes.js's scenes, which assume a
 * pre-installed release build): this scenario builds and installs its
 * *own* dev-mode build before timing anything, rather than assuming
 * whatever happens to already be on the device is dev-mode. This was a
 * real bug found during this ticket's own verification run --
 * `install.rig.fresh`/`install.rig.upgrade` (src/scenarios/install.js)
 * ran earlier in the same `--groups 6` invocation and installed the
 * *release* build over whatever was there, so `refresh.metro` found a
 * release build with no dev bundle / no Metro connection and every
 * iteration timed out waiting for a sentinel-file write that could never
 * happen. `run(ctx)` now always builds+installs its own debug variant
 * first, so it produces correct samples regardless of what any other
 * Group 6 entry did to the device beforehand or afterward.
 *
 * Still assumed, not auto-provisioned (matching every other scenario's
 * baseline precondition): Metro running on port 8081 (`npm start` in
 * rig/) and, for the Android leg, `adb reverse tcp:8081 tcp:8081`
 * already set up (the emulator's `10.0.2.2` host alias can also reach
 * Metro directly, but the reverse tunnel is the standard, more reliable
 * path). `ensureMetroRunning()` below fails fast with a clear message if
 * Metro isn't up rather than silently trying to build/install first.
 *
 * Android's `ACCESS_LOCAL_NETWORK` runtime permission (new at this AVD's
 * SDK level; declared in react-native's own debug-only manifest fragment,
 * `node_modules/react-native/ReactAndroid/src/debug/AndroidManifest.xml`
 * -- "apps that declare this must hold ACCESS_LOCAL_NETWORK to reach the
 * dev server over the local network. Loopback via `adb reverse` is
 * exempt") is pre-granted via `pm grant` before every launch so an
 * unattended run never blocks on the runtime prompt this ticket observed
 * manually during implementation ("Allow RigApp to find, connect to, and
 * determine the relative position of nearby devices?").
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { register } from '../registry.js';
import {
  ANDROID_APP_ID,
  IOS_BUNDLE_ID,
  buildSceneUrl,
  ensureAdbRoot,
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
} from '../rig-host.js';
import { ensureEmulatorRunning } from './boot.js';

const execFileAsync = promisify(execFile);

const rigDir = fileURLToPath(new URL('../../rig/', import.meta.url));
const markerScenePath = fileURLToPath(
  new URL('../../rig/src/scenes/RefreshMarkerScene.tsx', import.meta.url),
);

/** Matches rig/src/scenes/RefreshMarkerScene.tsx's MARKER_FILENAME. */
const MARKER_FILENAME = 'refresh-marker.local.txt';

/** Ticket scope: "n=20". */
const REFRESH_N = 20;
/** Generous headroom -- ticket predicts this loop as one of the larger
 * dev-loop gaps (H8: "2-10x worse"); a slow emulator-side Fast Refresh
 * still needs to land well inside this. */
const REFRESH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

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
 *   through to ensureEmulatorRunning so refresh.metro boots the
 *   config-appropriate AVD rather than always the tuned one).
 * @returns {Promise<string>}
 */
async function resolveEmulatorSerial(config) {
  await ensureEmulatorRunning(config);
  const serial = await firstAndroidDeviceSerial();
  if (!serial || !serial.startsWith('emulator-')) {
    throw new Error(
      `refresh.metro: no Android emulator device found in \`adb devices\` after ensureEmulatorRunning() (got "${serial ?? 'none'}") -- ` +
        `a non-emulator device must never be silently substituted (SPEC.md §3 non-goals: real devices).`,
    );
  }
  // The actual root cause found during this ticket's implementation,
  // after `adb reverse` turned out to be a red herring: `adb root`
  // access does not survive an emulator reboot (it resets to
  // unprivileged adbd on every fresh boot), and `ensureEmulatorRunning()`
  // (src/scenarios/boot.js) reboots the emulator whenever a preceding
  // boot scenario left it down. Without root, `adb shell cat` against
  // this app's private files dir (where the sentinel file this whole
  // scenario polls for lives) fails with a plain "Permission denied" --
  // confirmed directly: the scene was rendering the correct value on
  // screen the entire time every "timeout" was recorded; only the
  // *read* was failing, not the write or the render. Same fix as every
  // other module that reads an app's private files (src/rig-scenes.js,
  // src/scenarios/tti.js): call ensureAdbRoot before any such read.
  // Idempotent and cheap when already root, so calling it on every
  // resolveEmulatorSerial() call (not just once) costs nothing on the
  // common path and closes the gap on every path that matters.
  await ensureAdbRoot({ serial });
  return serial;
}

const MARKER_LINE_RE = /export const MARKER_VALUE = '([^']*)';/;

/**
 * @param {string} value
 * @returns {string}
 */
function markerLine(value) {
  return `export const MARKER_VALUE = '${value}';`;
}

/**
 * Rewrites the scene source's `MARKER_VALUE` literal to `newValue`,
 * returning the write's completion timestamp (ms since epoch) -- the
 * scenario's "save" moment the elapsed delta is measured from.
 * @param {string} newValue
 * @returns {Promise<number>}
 */
async function writeMarker(newValue) {
  const original = await readFile(markerScenePath, 'utf8');
  if (!MARKER_LINE_RE.test(original)) {
    throw new Error(
      `refresh.metro: MARKER_VALUE line not found in ${markerScenePath} -- scene source may have drifted from the format this driver expects`,
    );
  }
  const rewritten = original.replace(MARKER_LINE_RE, markerLine(newValue));
  await writeFile(markerScenePath, rewritten, 'utf8');
  return Date.now();
}

/**
 * Polls `adb shell cat` against the app's files-dir copy of the sentinel
 * file until its contents equal `expectedValue`, resolving with elapsed
 * ms from `sinceMs`.
 * @param {string} serial
 * @param {string} expectedValue
 * @param {number} sinceMs
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
async function awaitMarkerFileAndroid(serial, expectedValue, sinceMs, timeoutMs) {
  const remotePath = `/data/data/${ANDROID_APP_ID}/files/${MARKER_FILENAME}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('adb', ['-s', serial, 'shell', 'cat', remotePath]);
      if (stdout.trim() === expectedValue) {
        return Date.now() - sinceMs;
      }
    } catch {
      // File not there yet, or transient adb hiccup -- keep polling.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `refresh.metro: timed out after ${timeoutMs}ms waiting for marker file to read "${expectedValue}" (Android, ${remotePath})`,
  );
}

/**
 * Reads the sentinel file directly out of the booted simulator's app
 * container (CoreSimulator apps share the host filesystem, PLAN.md §3),
 * polling until its contents equal `expectedValue`.
 * @param {string} udid
 * @param {string} expectedValue
 * @param {number} sinceMs
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
async function awaitMarkerFileIos(udid, expectedValue, sinceMs, timeoutMs) {
  const { stdout } = await execFileAsync('xcrun', [
    'simctl',
    'get_app_container',
    udid,
    IOS_BUNDLE_ID,
    'data',
  ]);
  const filePath = path.join(stdout.trim(), 'Documents', MARKER_FILENAME);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(filePath, 'utf8');
      if (contents.trim() === expectedValue) {
        return Date.now() - sinceMs;
      }
    } catch {
      // File not there yet -- keep polling.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `refresh.metro: timed out after ${timeoutMs}ms waiting for marker file to read "${expectedValue}" (iOS, ${filePath})`,
  );
}

/**
 * Confirms Metro is reachable on port 8081 before starting the timed
 * loop -- a clear precondition failure ("Metro doesn't appear to be
 * running") is far more actionable than the first iteration's marker
 * wait silently timing out 30s later for the same root cause.
 * @returns {Promise<void>}
 */
async function ensureMetroRunning() {
  try {
    const { stdout } = await execFileAsync('curl', ['-s', '--max-time', '3', 'http://localhost:8081/status']);
    if (!stdout.includes('running')) {
      throw new Error(`unexpected /status response: ${stdout}`);
    }
  } catch (/** @type {any} */ err) {
    throw new Error(
      `refresh.metro: Metro does not appear to be running on http://localhost:8081 (${err?.message ?? err}) -- start it first with \`npm start\` in rig/`,
    );
  }
}

/**
 * Builds (`assembleDebug`) and installs the rig's debug APK on the given
 * serial, re-establishes `adb reverse tcp:8081 tcp:8081` (see below),
 * pre-grants `ACCESS_LOCAL_NETWORK` (see module doc comment) so the
 * runtime-permission prompt never blocks an unattended run, and
 * force-stops any previously-running instance so the very next launch is
 * a clean cold start of the fresh debug build.
 *
 * The `adb reverse` call is the fix for a real, reproducible failure
 * found during this ticket's own verification: in a full `--groups 6`
 * run, `boot.cold`/`boot.warm`/`boot.quickboot_reliability` all
 * legitimately shut the emulator down, and `ensureEmulatorRunning()`
 * (src/scenarios/boot.js, called by every later Group 6 entry's device
 * resolution) boots a *fresh* emulator process to bring it back --
 * `adb reverse` mappings are per-adb-connection-to-that-process and do
 * not survive a shutdown+reboot cycle, even though the resulting device
 * keeps the same serial (`emulator-5554`). Every prior scenario in the
 * matrix (install, transfer) reaches Metro only through Gradle's/
 * xcodebuild's own build-time bundling, so this went unnoticed until
 * `refresh.metro` -- the one scenario that needs a *live* Metro
 * connection at run time -- silently found no reverse mapping and every
 * seed/loop iteration timed out waiting for a bundle that could never
 * download. Confirmed directly: `adb -s emulator-5554 reverse --list`
 * was empty immediately after a real failure, and re-adding the mapping
 * by hand fixed the exact same launch instantly.
 * @param {string} serial
 * @returns {Promise<void>}
 */
async function buildAndInstallDebugAndroid(serial) {
  const androidDir = path.join(rigDir, 'android');
  await execFileAsync('./gradlew', ['installDebug'], {
    cwd: androidDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  await execFileAsync('adb', ['-s', serial, 'reverse', 'tcp:8081', 'tcp:8081']);
  // Best-effort: on API levels below the one that introduced this
  // permission, `pm grant` fails with "Unknown permission" -- harmless,
  // the prompt simply can't occur there either.
  await execFileAsync('adb', [
    '-s',
    serial,
    'shell',
    'pm',
    'grant',
    ANDROID_APP_ID,
    'android.permission.ACCESS_LOCAL_NETWORK',
  ]).catch(() => {});
  await execFileAsync('adb', ['-s', serial, 'shell', 'am', 'force-stop', ANDROID_APP_ID]);
}

/**
 * Builds (Debug configuration) and installs the rig's debug .app on the
 * given simulator UDID, force-terminating any previously-running instance
 * first.
 * @param {string} udid
 * @returns {Promise<void>}
 */
async function buildAndInstallDebugIos(udid) {
  const iosDir = path.join(rigDir, 'ios');
  // Same derived-data root as src/rig-host.js's buildIosRelease (already
  // covered by .gitignore's `rig/**/ios/build/` entry) -- Xcode nests
  // Debug-iphonesimulator/ and Release-iphonesimulator/ as separate
  // subdirectories under one derived-data root, so this coexists safely
  // with a release build's own artifacts there without needing (or
  // gitignoring) a second top-level build directory.
  const derivedDataPath = path.join(iosDir, 'build');
  await execFileAsync(
    'xcodebuild',
    [
      '-workspace',
      'RigApp.xcworkspace',
      '-scheme',
      'RigApp',
      '-configuration',
      'Debug',
      '-destination',
      `platform=iOS Simulator,id=${udid}`,
      '-derivedDataPath',
      derivedDataPath,
      'build',
    ],
    { cwd: iosDir, maxBuffer: 64 * 1024 * 1024 },
  );
  const appPath = path.join(derivedDataPath, 'Build/Products/Debug-iphonesimulator/RigApp.app');
  await execFileAsync('xcrun', ['simctl', 'terminate', udid, IOS_BUNDLE_ID]).catch(() => {});
  await execFileAsync('xcrun', ['simctl', 'install', udid, appPath]);
}

/** Seed-step timeout per attempt. Not REFRESH_TIMEOUT_MS's 30s: this is
 * the *first* JS bundle fetch+eval on a freshly (re)installed debug
 * build -- categorically slower than a warm Fast Refresh push. The
 * loop's own REFRESH_TIMEOUT_MS stays tight because *that* timing IS the
 * measurement; this seed step's timing never lands in `samples`. */
const SEED_TIMEOUT_MS = 90_000;
/** Total seed attempts before giving up (see seedRefreshMarkerScene doc). */
const SEED_MAX_ATTEMPTS = 3;

/**
 * Launches the `refresh.marker` scene and waits for its sentinel file to
 * appear with the baseline `'initial'` value -- this both warms the
 * Metro bundle-download + Fast-Refresh-socket connection (so iteration
 * 0's timed wait isn't also paying for that one-time cost) and confirms
 * the file-polling mechanism the loop depends on is actually working
 * before any sample is timed.
 *
 * Retries up to SEED_MAX_ATTEMPTS times (force-stop/terminate + relaunch
 * between attempts), each with its own SEED_TIMEOUT_MS window, rather
 * than one long wait -- a real run during this ticket's implementation
 * found the *first* cold bundle-fetch right after a Gradle build
 * (device/Metro still settling from a long preceding sequence of
 * boot/install/transfer scenarios in the same `--groups 6` invocation)
 * occasionally stalled past even 120s on one attempt, while a fresh
 * relaunch a few seconds later succeeded in under 10s -- a genuine
 * transient stall on the very first request, not a broken mechanism
 * (confirmed separately: this exact seed step, run standalone/warm,
 * consistently succeeds in under 10s). Throws only if every attempt
 * fails, still distinguishing "the mechanism is broken" from ordinary
 * mid-loop flakiness.
 * @param {'b'|'c'} leg
 * @param {string|null} [config] RunContext's `config` field (T13: threaded
 *   through to resolveEmulatorSerial so seeding boots the
 *   config-appropriate AVD rather than always the tuned one).
 * @returns {Promise<void>}
 */
async function seedRefreshMarkerScene(leg, config) {
  const url = buildSceneUrl('refresh.marker', {});
  /** @type {unknown} */
  let lastErr;
  for (let attempt = 1; attempt <= SEED_MAX_ATTEMPTS; attempt++) {
    try {
      if (leg === 'b') {
        const serial = await resolveEmulatorSerial(config);
        // Set-then-verify, not just set: a real run during this ticket's
        // implementation found `adb reverse tcp:8081 tcp:8081` return
        // success yet the mapping still be absent (or gone again) by the
        // time the app tried to use it moments later -- `adb reverse
        // --list` sometimes even failed outright with a transport error
        // in the same window, evidence of the underlying adb transport
        // itself being unstable after the long boot/install/transfer
        // sequence this scenario runs after, not just the mapping being
        // silently dropped. Loop set+verify a few times with a short
        // pause so a transiently-unstable transport gets a chance to
        // settle before this attempt gives up and falls through to the
        // (still-failing) launch, which would otherwise burn the whole
        // SEED_TIMEOUT_MS window on a connection that could never work.
        let reverseOk = false;
        for (let r = 0; r < 5 && !reverseOk; r++) {
          await execFileAsync('adb', ['-s', serial, 'reverse', 'tcp:8081', 'tcp:8081']).catch(() => {});
          try {
            const { stdout } = await execFileAsync('adb', ['-s', serial, 'reverse', '--list']);
            reverseOk = stdout.includes('tcp:8081 tcp:8081');
          } catch {
            reverseOk = false;
          }
          if (!reverseOk) await new Promise((r2) => setTimeout(r2, 2000));
        }
        if (!reverseOk) {
          throw new Error(
            `refresh.metro: could not establish a stable \`adb reverse tcp:8081 tcp:8081\` mapping to ${serial} after 5 tries`,
          );
        }
        await execFileAsync('adb', ['-s', serial, 'shell', 'am', 'force-stop', ANDROID_APP_ID]).catch(() => {});
        await execFileAsync('adb', [
          '-s',
          serial,
          'shell',
          'am',
          'start',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          url,
        ]);
        await awaitMarkerFileAndroid(serial, 'initial', Date.now(), SEED_TIMEOUT_MS);
      } else {
        const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
        await execFileAsync('xcrun', ['simctl', 'terminate', udid, IOS_BUNDLE_ID]).catch(() => {});
        await execFileAsync('xcrun', ['simctl', 'openurl', udid, url]);
        await awaitMarkerFileIos(udid, 'initial', Date.now(), SEED_TIMEOUT_MS);
      }
      return; // Success.
    } catch (err) {
      lastErr = err;
      // eslint-disable-next-line no-console
      console.log(
        `emu-bench: refresh.metro leg ${leg}: seed attempt ${attempt}/${SEED_MAX_ATTEMPTS} timed out, retrying...`,
      );
    }
  }
  throw new Error(
    `refresh.metro: seed step failed after ${SEED_MAX_ATTEMPTS} attempts on leg ${leg}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/**
 * Registers `refresh.metro` (PLAN.md §4 Group 6). Called as a side effect
 * of importing this module from run.js, matching src/kernels.js's
 * `registerKernelBenchmarks()` precedent.
 */
export function registerRefreshBenchmarks() {
  register({
    id: 'refresh.metro',
    group: 6,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'ms',
    async run(ctx) {
      if (ctx.leg !== 'b' && ctx.leg !== 'c') {
        throw new Error(`refresh.metro: unsupported leg "${ctx.leg}"`);
      }
      await ensureMetroRunning();

      // Self-provisioning (module doc comment): build+install this
      // scenario's own debug build rather than trusting whatever variant
      // another Group 6 entry left installed, then seed+warm the scene
      // once before timing anything.
      if (ctx.leg === 'b') {
        const serial = await resolveEmulatorSerial(ctx.config);
        await buildAndInstallDebugAndroid(serial);
      } else {
        const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
        await buildAndInstallDebugIos(udid);
      }
      await seedRefreshMarkerScene(ctx.leg, ctx.config);

      // Read-once-restore-once: capture the pristine file content before
      // any mutation so the finally block below can put it back exactly,
      // regardless of how many iterations completed or how the loop
      // exited (ticket acceptance criterion 3: clean tree on failure too).
      const originalContent = await readFile(markerScenePath, 'utf8');

      /** @type {number[]} */
      const samples = [];

      try {
        for (let i = 0; i < REFRESH_N; i++) {
          // A unique value every iteration (not just "on"/"off" toggling)
          // so a stale file read from iteration i-1 can never be mistaken
          // for iteration i's own re-render signal, even under polling
          // jitter or a slow native-module write.
          const value = `refresh-${i}-${Date.now()}`;
          const writtenAtMs = await writeMarker(value);
          const elapsedMs =
            ctx.leg === 'b'
              ? await awaitMarkerFileAndroid(
                  await resolveEmulatorSerial(ctx.config),
                  value,
                  writtenAtMs,
                  REFRESH_TIMEOUT_MS,
                )
              : await awaitMarkerFileIos(
                  (await firstBootedSimulatorUdid()) ?? 'booted',
                  value,
                  writtenAtMs,
                  REFRESH_TIMEOUT_MS,
                );
          samples.push(elapsedMs);
        }
      } finally {
        // Restore before checking anything else -- this must run even if
        // the loop above threw partway through (ticket acceptance
        // criterion 3's explicit "including on failure" requirement).
        await writeFile(markerScenePath, originalContent, 'utf8');
      }

      return samples;
    },
  });
}

export { markerLine, MARKER_LINE_RE, writeMarker, MARKER_FILENAME };
