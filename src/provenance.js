// @ts-check
/**
 * Provenance module (SPEC.md §7 `machine` + `toolchain`; §12). Captures
 * everything that makes a results file interpretable later: the machine
 * fingerprint, every external tool's version, and the power-source check
 * with its override.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Runs a command and returns trimmed stdout, or `null` if the binary is
 * missing / the command fails. Never throws — a missing tool is provenance
 * ("not installed"), not a crash.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<string|null>}
 */
async function tryRun(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ powerSource: string, onBattery: boolean }>}
 */
export async function getPowerSource() {
  const out = await tryRun('pmset', ['-g', 'batt']);
  if (out === null) {
    // No pmset (shouldn't happen on macOS) — assume AC rather than block
    // every run on an environment quirk we can't inspect.
    return { powerSource: 'unknown', onBattery: false };
  }
  const onBattery = /'Battery Power'/.test(out);
  return { powerSource: onBattery ? 'Battery' : 'AC', onBattery };
}

/**
 * @returns {Promise<string>} macOS's thermal pressure state, or "unknown"
 * if the sysctl key isn't present (older macOS).
 */
export async function getThermalPressure() {
  const out = await tryRun('sysctl', ['-n', 'machdep.xcpm.cpu_thermal_level']);
  if (out !== null) {
    const level = Number(out);
    if (!Number.isNaN(level)) {
      return level === 0 ? 'nominal' : `level ${level}`;
    }
  }
  // pmset also exposes a coarse thermal state on recent macOS.
  const pm = await tryRun('pmset', ['-g', 'therm']);
  if (pm) {
    const match = pm.match(/CPU_Scheduler_Limit\s*=\s*(\d+)/);
    if (match) {
      const limit = Number(match[1]);
      return limit >= 100 ? 'nominal' : `throttled (${limit}%)`;
    }
    // No warning level ever recorded reads as "hasn't thermal-throttled
    // since boot" — the common case on an idle/cool machine — rather than
    // truly unknown.
    if (/No thermal warning level has been recorded/i.test(pm)) {
      return 'nominal';
    }
  }
  return 'unknown';
}

/**
 * Captures SPEC §7 `machine`: model, chip, pCores, eCores, ramGB,
 * macosVersion, powerSource, thermalPressureStart.
 * @returns {Promise<import('./types.js').Machine>}
 */
export async function captureMachine() {
  const [
    model,
    chip,
    pCoresRaw,
    eCoresRaw,
    ramBytesRaw,
    macosVersion,
    { powerSource },
    thermalPressureStart,
  ] = await Promise.all([
    tryRun('sysctl', ['-n', 'hw.model']),
    tryRun('sysctl', ['-n', 'machdep.cpu.brand_string']),
    tryRun('sysctl', ['-n', 'hw.perflevel0.logicalcpu']),
    tryRun('sysctl', ['-n', 'hw.perflevel1.logicalcpu']),
    tryRun('sysctl', ['-n', 'hw.memsize']),
    tryRun('sw_vers', ['-productVersion']),
    getPowerSource(),
    getThermalPressure(),
  ]);

  const pCores = pCoresRaw ? Number(pCoresRaw) : 0;
  // Not every Mac has an E-core split (e.g. some configs report only
  // perflevel0); a missing key means 0 E-cores, not "unknown".
  const eCores = eCoresRaw ? Number(eCoresRaw) : 0;
  const ramGB = ramBytesRaw
    ? Math.round(Number(ramBytesRaw) / 1024 / 1024 / 1024)
    : 0;

  return {
    model: model ?? 'unknown',
    chip: chip ?? 'unknown',
    pCores,
    eCores,
    ramGB,
    macosVersion: macosVersion ?? 'unknown',
    powerSource,
    thermalPressureStart,
  };
}

async function getXcodeVersion() {
  const out = await tryRun('xcodebuild', ['-version']);
  if (!out) return null;
  const match = out.match(/^Xcode\s+(\S+)/m);
  return match ? match[1] : out.split('\n')[0];
}

async function getNewestIosRuntimeAndDeviceType() {
  const out = await tryRun('xcrun', ['simctl', 'list', '-j', 'runtimes']);
  let iosRuntime = null;
  if (out) {
    try {
      const parsed = JSON.parse(out);
      const iosRuntimes = (parsed.runtimes ?? []).filter(
        (/** @type {any} */ r) => r.identifier?.includes('iOS') && r.isAvailable,
      );
      iosRuntimes.sort((/** @type {any} */ a, /** @type {any} */ b) =>
        (a.version ?? '').localeCompare(b.version ?? '', undefined, {
          numeric: true,
        }),
      );
      const newest = iosRuntimes.at(-1);
      iosRuntime = newest ? `${newest.name} (${newest.version})` : null;
    } catch {
      // fall through with null
    }
  }

  const devicesOut = await tryRun('xcrun', ['simctl', 'list', '-j', 'devicetypes']);
  let deviceType = null;
  if (devicesOut) {
    try {
      const parsed = JSON.parse(devicesOut);
      const iphones = (parsed.devicetypes ?? []).filter(
        (/** @type {any} */ d) => d.identifier?.includes('iPhone'),
      );
      // `simctl list devicetypes` enumerates newest-to-oldest (verified
      // empirically: "iPhone 17 Pro" first, "iPhone 6s Plus" last) — take
      // the first iPhone entry as SPEC §6's "current-generation iPhone
      // device type". This picks whichever specific tier (Pro/Pro Max/
      // base) Apple's catalog happens to list first for the newest
      // generation — good enough for provenance, not a hardware review.
      deviceType = iphones.at(0)?.name ?? null;
    } catch {
      // fall through with null
    }
  }

  return { iosRuntime, deviceType };
}

async function getEmulatorVersion() {
  const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const emulatorBin = androidHome ? `${androidHome}/emulator/emulator` : 'emulator';
  const out = await tryRun(emulatorBin, ['-version']);
  if (!out) return null;
  const match = out.match(/Android emulator version\s+(\S+)/);
  return match ? match[1] : out.split('\n')[0];
}

/**
 * Parses `sdkmanager --list_installed` for the newest installed
 * `system-images;android-*;google_apis;arm64-v8a` entry and NDK version.
 * @returns {Promise<{ systemImage: string|null, apiLevel: number, ndk: string|null }>}
 */
async function getSdkInfo() {
  const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!androidHome) return { systemImage: null, apiLevel: 0, ndk: null };
  const sdkmanagerCandidates = [
    `${androidHome}/cmdline-tools/latest/bin/sdkmanager`,
    `${androidHome}/cmdline-tools/bin/sdkmanager`,
    `${androidHome}/tools/bin/sdkmanager`,
  ];
  let out = null;
  for (const candidate of sdkmanagerCandidates) {
    out = await tryRun(candidate, ['--list_installed']);
    if (out) break;
  }
  if (!out) return { systemImage: null, apiLevel: 0, ndk: null };

  const imageLines = out
    .split('\n')
    .filter((l) => l.includes('system-images;') && l.includes('google_apis') && l.includes('arm64-v8a'));
  let systemImage = null;
  let apiLevel = 0;
  for (const line of imageLines) {
    const match = line.match(/system-images;android-(\d+);google_apis[^;]*;arm64-v8a/);
    if (match) {
      const level = Number(match[1]);
      if (level > apiLevel) {
        apiLevel = level;
        systemImage = match[0];
      }
    }
  }

  const ndkLine = out.split('\n').find((l) => l.trim().startsWith('ndk;'));
  const ndk = ndkLine ? ndkLine.trim().split('|')[0].trim() : null;

  return { systemImage, apiLevel, ndk };
}

async function getGitSha() {
  return tryRun('git', ['rev-parse', 'HEAD']);
}

/**
 * Captures SPEC §7 `toolchain`: xcode, iosRuntime, deviceType,
 * emulatorVersion, systemImage, apiLevel, ndk, rnVersion, maestro, node.
 * Fields for tools that aren't installed are `null` (not thrown away —
 * `doctor`/`run` surface them as skips elsewhere).
 * @returns {Promise<import('./types.js').Toolchain>}
 */
export async function captureToolchain() {
  const [xcode, iosInfo, emulatorVersion, sdkInfo, maestro] = await Promise.all([
    getXcodeVersion(),
    getNewestIosRuntimeAndDeviceType(),
    getEmulatorVersion(),
    getSdkInfo(),
    tryRun('maestro', ['--version']),
  ]);

  return {
    xcode: xcode ?? 'not installed',
    iosRuntime: iosInfo.iosRuntime ?? 'not installed',
    deviceType: iosInfo.deviceType ?? 'not installed',
    emulatorVersion: emulatorVersion ?? 'not installed',
    systemImage: sdkInfo.systemImage ?? 'not installed',
    apiLevel: sdkInfo.apiLevel,
    ndk: sdkInfo.ndk ?? 'not installed',
    // rnVersion is populated once the rig app exists (T04); T01 has no rig.
    rnVersion: 'n/a (rig not yet built — see T04)',
    maestro: maestro ?? 'not installed',
    node: process.version,
  };
}

/**
 * Captures the `run` block's `suiteGitSha` (SPEC §7 `run.suiteGitSha`).
 * @returns {Promise<string>}
 */
export async function captureGitSha() {
  const sha = await getGitSha();
  return sha ?? 'unknown';
}
