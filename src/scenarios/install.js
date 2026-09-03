// @ts-check
/**
 * Install scenarios (PLAN.md §4 Group 6, H8; SPEC.md §11; ticket T10
 * scope). `adb install` vs `simctl install`, timed, for both a
 * hello-world app (hello/ -- see hello/README.md for the fixture-vs-
 * second-app-id decision) and the full rig app, fresh and upgrade
 * variants. Registers four BenchmarkEntry ids, each supporting legs b/c:
 *
 *   - `install.hello.fresh` / `install.hello.upgrade`
 *   - `install.rig.fresh` / `install.rig.upgrade`
 *
 * "Fresh" times an install onto a device with the app not already present
 * (uninstalled first, ignoring failure if it wasn't there); "upgrade"
 * times installing a different build over an already-installed one
 * (`adb install -r` / `simctl install`, both idempotent-overwrite by
 * design) -- each scenario builds two version variants once (v1, v2) and
 * alternates which one is "already installed" vs "the upgrade" across
 * iterations so every upgrade sample is a real version bump, never a
 * same-version no-op reinstall.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants as fsConstants, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { register } from '../registry.js';
import { firstAndroidDeviceSerial, firstBootedSimulatorUdid, buildAndroidRelease, buildIosRelease } from '../rig-host.js';
import { ensureEmulatorRunning } from './boot.js';

const execFileAsync = promisify(execFile);

const helloDir = fileURLToPath(new URL('../../hello/', import.meta.url));
const rigDir = fileURLToPath(new URL('../../rig/', import.meta.url));

const HELLO_ANDROID_APP_ID = 'com.emubench.hello';
const HELLO_IOS_BUNDLE_ID = 'com.emubench.hello';
const RIG_ANDROID_APP_ID = 'com.emubench.rig';
const RIG_IOS_BUNDLE_ID = 'com.emubench.rig';

/** Ticket scope: "n>=10 unless noted" (PLAN.md §5 macro floor). Floor+2
 * (12), not a bare 10 -- T13's orchestrator discards 2 warmup samples
 * uniformly (PLAN.md §5, SPEC.md §12), so an entry sized at exactly the
 * floor would report n=8 after discarding. Discovered as a real T13
 * integration bug during this ticket's own rehearsal run. */
const INSTALL_N = 12;

/**
 * Resolves the Android target device, refusing to silently fall back to
 * a real physical device the way `firstAndroidDeviceSerial()` alone would
 * (real devices are an explicit non-goal, SPEC.md §3) -- discovered
 * during this ticket's own verification run: a physical Pixel 6a happened
 * to be attached over adb-tls alongside the emulator, and once a prior
 * boot scenario in the same `run` left the emulator shut down (boot.cold/
 * boot.warm/boot.quickboot_reliability all legitimately end with the
 * emulator off -- that's what "full shutdown between iterations" means),
 * `firstAndroidDeviceSerial()`'s `?? serials[0]` fallback silently
 * started installing onto the physical phone instead of failing loudly.
 * @param {string|null} [config] RunContext's `config` field (T13: threaded
 *   through to ensureEmulatorRunning so install.rig/install.hello boot the
 *   config-appropriate AVD rather than always the tuned one).
 * @returns {Promise<string>}
 */
async function resolveEmulatorSerial(config) {
  await ensureEmulatorRunning(config);
  const serial = await firstAndroidDeviceSerial();
  if (serial && serial.startsWith('emulator-')) return serial;
  throw new Error(
    `install: no Android emulator device found in \`adb devices\` after ensureEmulatorRunning() (got "${serial ?? 'none'}") -- ` +
      `a non-emulator device must never be silently substituted (SPEC.md §3 non-goals: real devices).`,
  );
}

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
 * Ensures `hello/android/local.properties` points at the local Android
 * SDK -- gitignored (matches rig/android's own local.properties
 * precedent), so a fresh clone needs it written before Gradle can resolve
 * the SDK. Idempotent: only writes if the file is missing or doesn't
 * already contain a `sdk.dir` line.
 *
 * Falls back to reading `rig/android/local.properties`'s own already-
 * resolved `sdk.dir` when `$ANDROID_HOME`/`$ANDROID_SDK_ROOT` aren't set
 * in the environment -- this suite's own doctor/build tooling (T02, T04)
 * has already resolved and pinned the SDK path there for this exact
 * machine, so reusing it is more reliable than requiring the shell
 * variable to also be set for this one Gradle project.
 * @returns {Promise<void>}
 */
async function ensureHelloLocalProperties() {
  const localPropsPath = path.join(helloDir, 'android', 'local.properties');
  let androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!androidHome) {
    const rigLocalPropsPath = path.join(rigDir, 'android', 'local.properties');
    if (await fileExists(rigLocalPropsPath)) {
      const { readFile } = await import('node:fs/promises');
      const rigProps = await readFile(rigLocalPropsPath, 'utf8');
      const match = rigProps.match(/^sdk\.dir=(.+)$/m);
      if (match) androidHome = match[1].trim();
    }
  }
  if (!androidHome) return; // Nothing to write; Gradle will surface its own clear error.
  if (await fileExists(localPropsPath)) {
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(localPropsPath, 'utf8');
    if (existing.includes('sdk.dir=')) return;
  }
  await writeFile(localPropsPath, `sdk.dir=${androidHome}\n`, 'utf8');
}

/**
 * Builds the hello Android fixture at a given version code, returning the
 * built APK's path (hello/README.md: `-PhelloVersionCode=N` overrides
 * `versionCode`/`versionName`, defaulting to 1 when omitted).
 * @param {number} versionCode
 * @returns {Promise<string>}
 */
async function buildHelloAndroid(versionCode) {
  await ensureHelloLocalProperties();
  const androidDir = path.join(helloDir, 'android');
  await execFileAsync(
    './gradlew',
    ['assembleRelease', `-PhelloVersionCode=${versionCode}`],
    { cwd: androidDir, maxBuffer: 64 * 1024 * 1024 },
  );
  return path.join(androidDir, 'app/build/outputs/apk/release/app-release.apk');
}

/**
 * Builds the hello iOS fixture at a given build number, returning the
 * built .app's path (hello/README.md: `HELLO_BUILD_NUMBER=N` build
 * setting override, defaulting to 1 when omitted).
 * @param {number} buildNumber
 * @param {string} udid
 * @returns {Promise<string>}
 */
async function buildHelloIos(buildNumber, udid) {
  const iosDir = path.join(helloDir, 'ios');
  const derivedDataPath = path.join(iosDir, `build-v${buildNumber}`);
  await execFileAsync(
    'xcodebuild',
    [
      '-project',
      'HelloApp.xcodeproj',
      '-scheme',
      'HelloApp',
      '-configuration',
      'Release',
      '-destination',
      `platform=iOS Simulator,id=${udid}`,
      '-derivedDataPath',
      derivedDataPath,
      `HELLO_BUILD_NUMBER=${buildNumber}`,
      'build',
    ],
    { cwd: iosDir, maxBuffer: 64 * 1024 * 1024 },
  );
  return path.join(derivedDataPath, 'Build/Products/Release-iphonesimulator/HelloApp.app');
}

/**
 * Times a single `adb install -r <path>` call.
 * @param {string} apkPath
 * @param {string} serial
 * @returns {Promise<number>} elapsed ms
 */
async function timedAdbInstall(apkPath, serial) {
  const startedAt = Date.now();
  await execFileAsync('adb', ['-s', serial, 'install', '-r', apkPath], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return Date.now() - startedAt;
}

/**
 * Times a single `xcrun simctl install <udid> <path>` call.
 * @param {string} appPath
 * @param {string} udid
 * @returns {Promise<number>} elapsed ms
 */
async function timedSimctlInstall(appPath, udid) {
  const startedAt = Date.now();
  await execFileAsync('xcrun', ['simctl', 'install', udid, appPath]);
  return Date.now() - startedAt;
}

/**
 * @param {string} appId
 * @param {string} serial
 */
async function uninstallAndroid(appId, serial) {
  await execFileAsync('adb', ['-s', serial, 'uninstall', appId]).catch(() => {});
}

/**
 * @param {string} bundleId
 * @param {string} udid
 */
async function uninstallIos(bundleId, udid) {
  await execFileAsync('xcrun', ['simctl', 'uninstall', udid, bundleId]).catch(() => {});
}

/**
 * Runs the shared fresh/upgrade install protocol for one leg, given the
 * two build paths (v1, v2) and platform-specific install/uninstall
 * primitives. "Fresh" samples uninstall then install v1 each iteration;
 * "upgrade" samples install v2 over the v1 that the fresh half just left
 * behind, then reset back to v1 for the next iteration's fresh half --
 * this keeps the two variants' iterations interleaved 1:1 (fresh[i] then
 * upgrade[i]) so an upgrade sample is never accidentally measuring a
 * fresh install (device with nothing installed) or a same-version no-op.
 * @param {{
 *   uninstall: () => Promise<void>,
 *   installTimed: (path: string) => Promise<number>,
 *   v1Path: string,
 *   v2Path: string,
 *   n: number,
 * }} args
 * @returns {Promise<{ freshSamplesS: number[], upgradeSamplesS: number[] }>}
 */
async function runFreshAndUpgrade({ uninstall, installTimed, v1Path, v2Path, n }) {
  /** @type {number[]} */
  const freshSamplesS = [];
  /** @type {number[]} */
  const upgradeSamplesS = [];

  for (let i = 0; i < n; i++) {
    // Fresh: nothing installed -> install v1.
    await uninstall();
    const freshMs = await installTimed(v1Path);
    freshSamplesS.push(freshMs / 1000);

    // Upgrade: v1 installed -> install v2 over it.
    const upgradeMs = await installTimed(v2Path);
    upgradeSamplesS.push(upgradeMs / 1000);
  }

  return { freshSamplesS, upgradeSamplesS };
}

/**
 * Registers `install.hello.fresh`/`.upgrade` and `install.rig.fresh`/
 * `.upgrade` (PLAN.md §4 Group 6). Called as a side effect of importing
 * this module from run.js, matching src/kernels.js's
 * `registerKernelBenchmarks()` precedent.
 */
export function registerInstallBenchmarks() {
  // A single run of both hello variants builds both APKs/.apps once and
  // reuses them for both the fresh and upgrade entries -- registry
  // entries are independent BenchmarkEntry objects, but the underlying
  // build artifacts don't need rebuilding per entry, so a tiny in-module
  // memo (keyed by leg) avoids doing the Gradle/xcodebuild build twice
  // per `run` invocation when both install.hello.* ids run back to back.
  /** @type {Record<string, Promise<{v1: string, v2: string}>>} */
  const helloBuildCache = {};

  /**
   * @param {'b'|'c'} leg
   * @returns {Promise<{v1: string, v2: string}>}
   */
  async function ensureHelloBuilds(leg) {
    if (!helloBuildCache[leg]) {
      helloBuildCache[leg] = (async () => {
        if (leg === 'b') {
          const [v1, v2] = await Promise.all([buildHelloAndroid(1), buildHelloAndroid(2)]);
          return { v1, v2 };
        }
        const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
        const [v1, v2] = await Promise.all([buildHelloIos(1, udid), buildHelloIos(2, udid)]);
        return { v1, v2 };
      })();
    }
    return helloBuildCache[leg];
  }

  /** @type {Record<string, Promise<{v1: string, v2: string}>>} */
  const rigBuildCache = {};

  /**
   * The rig app has no first-class "bump the version and rebuild" hook
   * the way hello/ does (SPEC.md §9 doesn't version the rig build), so
   * the upgrade variant reuses the *same* release build for both v1 and
   * v2 -- `adb install -r` / `simctl install` both accept reinstalling
   * the identical build (same-version "upgrade" still exercises the real
   * install transport path end to end; it just isn't a version bump).
   * Documented here rather than silently treated as equivalent to
   * hello's true version-bump upgrade.
   * @param {'b'|'c'} leg
   * @returns {Promise<{v1: string, v2: string}>}
   */
  async function ensureRigBuild(leg) {
    if (!rigBuildCache[leg]) {
      rigBuildCache[leg] = (async () => {
        if (leg === 'b') {
          const apkPath = await buildAndroidRelease({ rigDir });
          return { v1: apkPath, v2: apkPath };
        }
        const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
        const appPath = await buildIosRelease({ rigDir, udid });
        return { v1: appPath, v2: appPath };
      })();
    }
    return rigBuildCache[leg];
  }

  // --- install.hello ---------------------------------------------------

  for (const variant of /** @type {const} */ (['fresh', 'upgrade'])) {
    register({
      id: `install.hello.${variant}`,
      group: 6,
      legs: ['b', 'c'],
      kind: 'macro',
      unit: 's',
      async run(ctx) {
        if (ctx.leg !== 'b' && ctx.leg !== 'c') {
          throw new Error(`install.hello.${variant}: unsupported leg "${ctx.leg}"`);
        }
        const { v1, v2 } = await ensureHelloBuilds(ctx.leg);

        if (ctx.leg === 'b') {
          const serial = await resolveEmulatorSerial(ctx.config);
          const { freshSamplesS, upgradeSamplesS } = await runFreshAndUpgrade({
            uninstall: () => uninstallAndroid(HELLO_ANDROID_APP_ID, serial),
            installTimed: (p) => timedAdbInstall(p, serial),
            v1Path: v1,
            v2Path: v2,
            n: INSTALL_N,
          });
          return variant === 'fresh' ? freshSamplesS : upgradeSamplesS;
        }

        const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
        const { freshSamplesS, upgradeSamplesS } = await runFreshAndUpgrade({
          uninstall: () => uninstallIos(HELLO_IOS_BUNDLE_ID, udid),
          installTimed: (p) => timedSimctlInstall(p, udid),
          v1Path: v1,
          v2Path: v2,
          n: INSTALL_N,
        });
        return variant === 'fresh' ? freshSamplesS : upgradeSamplesS;
      },
    });
  }

  // --- install.rig -----------------------------------------------------

  for (const variant of /** @type {const} */ (['fresh', 'upgrade'])) {
    register({
      id: `install.rig.${variant}`,
      group: 6,
      legs: ['b', 'c'],
      kind: 'macro',
      unit: 's',
      async run(ctx) {
        if (ctx.leg !== 'b' && ctx.leg !== 'c') {
          throw new Error(`install.rig.${variant}: unsupported leg "${ctx.leg}"`);
        }
        const { v1, v2 } = await ensureRigBuild(ctx.leg);

        if (ctx.leg === 'b') {
          const serial = await resolveEmulatorSerial(ctx.config);
          const { freshSamplesS, upgradeSamplesS } = await runFreshAndUpgrade({
            uninstall: () => uninstallAndroid(RIG_ANDROID_APP_ID, serial),
            installTimed: (p) => timedAdbInstall(p, serial),
            v1Path: v1,
            v2Path: v2,
            n: INSTALL_N,
          });
          return variant === 'fresh' ? freshSamplesS : upgradeSamplesS;
        }

        const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
        const { freshSamplesS, upgradeSamplesS } = await runFreshAndUpgrade({
          uninstall: () => uninstallIos(RIG_IOS_BUNDLE_ID, udid),
          installTimed: (p) => timedSimctlInstall(p, udid),
          v1Path: v1,
          v2Path: v2,
          n: INSTALL_N,
        });
        return variant === 'fresh' ? freshSamplesS : upgradeSamplesS;
      },
    });
  }
}
