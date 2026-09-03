// @ts-check
/**
 * Android SDK helpers specific to `emu-bench doctor` (SPEC.md §5 table, §6
 * AVD definitions) that go beyond what `provenance.js` already captures for
 * results files: locating the SDK tools, finding the *latest available*
 * stable `google_apis` arm64 system image (not just what's installed),
 * checking license acceptance without ever shelling out to something that
 * can hang waiting on stdin, and creating/reading back the two AVDs.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string } | null>} null if the
 *   binary is missing or the command fails — never throws.
 */
async function tryRun(cmd, args, opts = {}) {
  try {
    const result = await execFileAsync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      input: opts.input,
    });
    return result;
  } catch (/** @type {any} */ err) {
    // Some CLIs (sdkmanager) exit non-zero yet still print usable stdout
    // (e.g. `--list` warnings). Surface stdout when we have it.
    if (err && typeof err.stdout === 'string' && err.stdout.length > 0) {
      return { stdout: err.stdout, stderr: err.stderr ?? '' };
    }
    return null;
  }
}

/**
 * @returns {string|undefined}
 */
export function getAndroidHome() {
  return process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
}

/**
 * Resolves the `sdkmanager` binary path under a given SDK root, trying the
 * cmdline-tools layouts Google has shipped (`cmdline-tools/latest`,
 * `cmdline-tools/<version>`, legacy `tools/bin`).
 * @param {string} androidHome
 * @param {'sdkmanager'|'avdmanager'} tool
 * @returns {Promise<string|null>}
 */
async function resolveCmdlineTool(androidHome, tool) {
  const candidates = [`${androidHome}/cmdline-tools/latest/bin/${tool}`];
  try {
    const entries = await readdir(`${androidHome}/cmdline-tools`, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'latest') {
        candidates.push(`${androidHome}/cmdline-tools/${entry.name}/bin/${tool}`);
      }
    }
  } catch {
    // cmdline-tools/ doesn't exist at all — fall through to legacy path.
  }
  candidates.push(`${androidHome}/tools/bin/${tool}`);

  for (const candidate of candidates) {
    // execFile with a bogus arg still confirms the binary is invokable;
    // cheaper is just checking the file exists via readFile-based stat-ish
    // probe, but we want an actually-runnable binary, so try --version-ish
    // no-op: `sdkmanager`/`avdmanager` both accept no args (print usage,
    // exit 0 or 1) without hanging, so this is safe and fast.
    const out = await tryRun(candidate, ['--version']);
    if (out !== null) return candidate;
  }
  return null;
}

/**
 * @returns {Promise<{
 *   androidHome: string|null,
 *   sdkmanagerPath: string|null,
 *   avdmanagerPath: string|null,
 *   emulatorPath: string|null,
 *   adbPath: string|null,
 * }>}
 */
export async function locateAndroidTools() {
  const androidHome = getAndroidHome() ?? null;

  if (!androidHome) {
    // Even with no ANDROID_HOME, `emulator`/`adb` might still be on PATH
    // (e.g. Homebrew platform-tools) — check PATH-resolved binaries too, so
    // the readiness grid reflects what a shell command would actually do.
    const [emulatorOnPath, adbOnPath] = await Promise.all([
      tryRun('emulator', ['-version']),
      tryRun('adb', ['version']),
    ]);
    return {
      androidHome: null,
      sdkmanagerPath: null,
      avdmanagerPath: null,
      emulatorPath: emulatorOnPath ? 'emulator' : null,
      adbPath: adbOnPath ? 'adb' : null,
    };
  }

  const [sdkmanagerPath, avdmanagerPath] = await Promise.all([
    resolveCmdlineTool(androidHome, 'sdkmanager'),
    resolveCmdlineTool(androidHome, 'avdmanager'),
  ]);

  const emulatorCandidate = `${androidHome}/emulator/emulator`;
  const adbCandidate = `${androidHome}/platform-tools/adb`;
  const [emulatorOut, adbOut] = await Promise.all([
    tryRun(emulatorCandidate, ['-version']),
    tryRun(adbCandidate, ['version']),
  ]);

  return {
    androidHome,
    sdkmanagerPath,
    avdmanagerPath,
    emulatorPath: emulatorOut ? emulatorCandidate : null,
    adbPath: adbOut ? adbCandidate : null,
  };
}

/**
 * Non-interactive, non-hanging license-acceptance check. `sdkmanager
 * --licenses` fetches the remote repository listing and then prompts
 * per-license on stdin — exactly what SPEC.md §5 says never to do ("if
 * licenses unaccepted, print the `sdkmanager --licenses` instruction instead
 * of hanging"). Instead, this reads `$ANDROID_HOME/licenses/` directly:
 * `sdkmanager` itself writes one file per accepted license (named after the
 * license id, containing its hash), so presence of the hash files it
 * consults is the same signal without ever invoking a prompting command.
 * @param {string} androidHome
 * @returns {Promise<{ accepted: boolean, missing: string[] }>}
 */
export async function checkLicensesAccepted(androidHome) {
  // The two licenses that gate everything doctor installs (system images,
  // NDK): the standard SDK license, and the (rarely relevant) preview
  // license some emulator packages require. If the file is present at all,
  // sdkmanager considers that license accepted.
  const required = ['android-sdk-license'];
  const licensesDir = `${androidHome}/licenses`;
  let present = [];
  try {
    present = await readdir(licensesDir);
  } catch {
    present = [];
  }
  const missing = required.filter((id) => !present.includes(id));
  return { accepted: missing.length === 0, missing };
}

/**
 * Parses `sdkmanager --list --channel=0` (stable channel only) for every
 * `system-images;android-*;google_apis;arm64-v8a` line — plain Google APIs,
 * not `google_apis_playstore` (SPEC.md §6: "Google APIs, not Play — `adb
 * root` required") — and returns the highest API-level one. This is the
 * *available* image, which may differ from what's installed.
 * @param {string} sdkmanagerPath
 * @returns {Promise<{ id: string|null, apiLevel: number }>}
 */
export async function findLatestStableGoogleApisArm64(sdkmanagerPath) {
  const out = await tryRun(sdkmanagerPath, ['--list', '--channel=0'], { input: '' });
  if (!out) return { id: null, apiLevel: 0 };

  const lines = out.stdout.split('\n');
  let best = { id: /** @type {string|null} */ (null), apiLevel: 0 };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('system-images;')) continue;
    // Exact tag match: "google_apis" only — excludes google_apis_playstore,
    // google_apis_ps16k, google_apis_playstore_ps16k, google_apis_tablet.
    const match = trimmed.match(/^(system-images;android-(\d+(?:\.\d+)?);google_apis;arm64-v8a)\s*\|/);
    if (!match) continue;
    const apiLevel = Number(match[2]);
    if (apiLevel > best.apiLevel) {
      best = { id: match[1], apiLevel };
    }
  }
  return best;
}

/**
 * @param {string} sdkmanagerPath
 * @returns {Promise<{ installed: string[] }>}
 */
async function listInstalledPackages(sdkmanagerPath) {
  const out = await tryRun(sdkmanagerPath, ['--list_installed']);
  if (!out) return { installed: [] };
  const installed = out.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('Installed packages') && !l.includes('---') && !l.startsWith('Path'))
    .map((l) => l.split('|')[0].trim())
    .filter(Boolean);
  return { installed };
}

/**
 * Installs a package via `sdkmanager <packageId>`, printing the exact
 * command before running it (SPEC.md §5: "Auto-fixes print the exact
 * command before running it"). No-op (returns immediately) if the package
 * looks already installed, so re-running doctor is idempotent and never
 * re-downloads.
 * @param {string} sdkmanagerPath
 * @param {string} packageId
 * @returns {Promise<{ ranInstall: boolean, ok: boolean, message: string }>}
 */
export async function installSdkPackage(sdkmanagerPath, packageId) {
  const { installed } = await listInstalledPackages(sdkmanagerPath);
  if (installed.includes(packageId)) {
    return { ranInstall: false, ok: true, message: `already installed: ${packageId}` };
  }
  const command = `${sdkmanagerPath} "${packageId}"`;
  // stderr, not stdout: `doctor --json` must have pure JSON on stdout for
  // the orchestrator to parse, on every path — including the "fixed
  // something" path, which is precisely when this line fires.
  console.error(`emu-bench doctor: running: ${command}`);
  try {
    // Empty stdin: if this package's license were somehow still unaccepted
    // despite the pre-check, sdkmanager would print a rejection rather than
    // block forever reading from a closed pipe.
    await execFileAsync(sdkmanagerPath, [packageId], { encoding: 'utf8', input: '', maxBuffer: 64 * 1024 * 1024 });
    return { ranInstall: true, ok: true, message: `installed: ${packageId}` };
  } catch (/** @type {any} */ err) {
    return {
      ranInstall: true,
      ok: false,
      message: `install failed for ${packageId}: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * Finds the newest installed NDK version string (e.g. "27.1.12297006") and
 * the newest *available* stable one, so doctor can tell "installed" from
 * "stale" the same way it does for system images.
 * @param {string} sdkmanagerPath
 * @returns {Promise<{ installedNewest: string|null, availableNewest: string|null }>}
 */
export async function findNdkVersions(sdkmanagerPath) {
  const [installedOut, availableOut] = await Promise.all([
    tryRun(sdkmanagerPath, ['--list_installed']),
    tryRun(sdkmanagerPath, ['--list', '--channel=0'], { input: '' }),
  ]);

  /** @param {string|null|undefined} text */
  const newestNdk = (text) => {
    if (!text) return null;
    let best = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      const match = trimmed.match(/^ndk;(\d+\.\d+\.\d+)\s*\|/);
      if (match) {
        if (!best || compareVersions(match[1], best) > 0) best = match[1];
      }
    }
    return best;
  };

  return {
    installedNewest: newestNdk(installedOut?.stdout),
    availableNewest: newestNdk(availableOut?.stdout),
  };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Reads back an AVD's `config.ini` as a flat string-keyed object, for
 * provenance (SPEC.md §7 `config.avdTuned`/`config.avdDefault`, ticket line
 * 15: "Record both AVDs' effective config.ini values for provenance").
 * @param {string} avdName
 * @returns {Promise<Record<string, string>>}
 */
export async function readAvdConfig(avdName) {
  const home = process.env.HOME ?? '';
  const configPath = path.join(home, '.android', 'avd', `${avdName}.avd`, 'config.ini');
  try {
    const raw = await readFile(configPath, 'utf8');
    /** @type {Record<string, string>} */
    const config = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return config;
  } catch {
    return {};
  }
}

/**
 * @returns {Promise<string[]>} names of AVDs currently known to `avdmanager`
 *   / present under `~/.android/avd`.
 */
export async function listExistingAvdNames() {
  const home = process.env.HOME ?? '';
  const avdDir = path.join(home, '.android', 'avd');
  try {
    const entries = await readdir(avdDir);
    return entries.filter((e) => e.endsWith('.ini')).map((e) => e.replace(/\.ini$/, ''));
  } catch {
    return [];
  }
}

/**
 * Creates an AVD via `avdmanager create avd`, printing the exact command
 * first (SPEC.md §5). Idempotent: if an AVD by this name already exists,
 * this is a no-op (ticket acceptance: "Running doctor twice is idempotent
 * (no duplicate AVDs, no re-downloads)") — it does NOT pass `--force`.
 * @param {string} avdmanagerPath
 * @param {{ name: string, packageId: string, device?: string, extraConfig?: Record<string,string> }} args
 * @returns {Promise<{ created: boolean, ok: boolean, message: string }>}
 */
export async function createAvdIfMissing(avdmanagerPath, { name, packageId, device, extraConfig }) {
  const existing = await listExistingAvdNames();
  if (existing.includes(name)) {
    return { created: false, ok: true, message: `AVD "${name}" already exists` };
  }

  const args = ['create', 'avd', '-n', name, '-k', packageId];
  if (device) args.push('-d', device);
  const command = `${avdmanagerPath} ${args.join(' ')}`;
  // stderr, not stdout — see the note in installSdkPackage() above: `doctor
  // --json` must have pure JSON on stdout even when this fires.
  console.error(`emu-bench doctor: running: ${command}`);
  try {
    // avdmanager asks "Do you wish to create a custom hardware profile?
    // [no]" on stdin for some device profiles; answering with a newline
    // (i.e. accept the [no] default) keeps this non-interactive.
    await execFileAsync(avdmanagerPath, args, { encoding: 'utf8', input: 'no\n' });
  } catch (/** @type {any} */ err) {
    return {
      created: false,
      ok: false,
      message: `avdmanager create avd failed for "${name}": ${err?.message ?? String(err)}`,
    };
  }

  if (extraConfig && Object.keys(extraConfig).length > 0) {
    await applyConfigOverrides(name, extraConfig);
  }

  return { created: true, ok: true, message: `created AVD "${name}"` };
}

/**
 * Rewrites specific keys in an AVD's `config.ini` in place, preserving
 * every other line exactly as `avdmanager` wrote it (SPEC.md §6 tuned AVD:
 * `hw.cpu.ncore` and `hw.ramSize` overrides on top of otherwise-default
 * creation).
 * @param {string} avdName
 * @param {Record<string,string>} overrides
 * @returns {Promise<void>}
 */
export async function applyConfigOverrides(avdName, overrides) {
  const home = process.env.HOME ?? '';
  const configPath = path.join(home, '.android', 'avd', `${avdName}.avd`, 'config.ini');
  const raw = await readFile(configPath, 'utf8');
  const lines = raw.split('\n');
  const seen = new Set();
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in overrides) {
      seen.add(key);
      return `${key}=${overrides[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (!seen.has(key)) rewritten.push(`${key}=${value}`);
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, rewritten.join('\n'), 'utf8');
}

/**
 * Boots an AVD headlessly with a bounded timeout, watching for either a
 * successful boot or QEMU's specific "SMP CPUs requested exceeds max CPUs
 * supported by machine" failure (observed on this host: a 12-P-core Mac
 * against Android Emulator 37.1.11.0's `mach-virt` cap of 8 vCPUs — SPEC.md
 * §6 sets `hw.cpu.ncore` to the host's P-core count uncapped, so any host
 * with more P-cores than the emulator's compiled-in `mach-virt` limit hits
 * this same failure). Always cleans up the emulator process before
 * returning, whichever outcome occurred, so doctor never leaves a booted
 * or half-booted device behind it.
 * @param {{ emulatorPath: string, adbPath: string, avdName: string, timeoutMs?: number }} args
 * @returns {Promise<{ outcome: 'booted'|'smp-cap-exceeded'|'timeout'|'error', maxSmpCpus?: number, message: string }>}
 */
export async function bootProbe({ emulatorPath, adbPath, avdName, timeoutMs = 90_000 }) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(emulatorPath, ['-avd', avdName, '-no-snapshot-load', '-no-window', '-no-audio'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let stderrBuf = '';
    /** @type {NodeJS.Timeout|null} */
    let pollTimer = null;
    /** @type {NodeJS.Timeout|null} */
    let hardTimeout = null;

    const cleanupAndResolve = (/** @type {{ outcome: 'booted'|'smp-cap-exceeded'|'timeout'|'error', maxSmpCpus?: number, message: string }} */ result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      // Best-effort graceful kill, then force-kill shortly after — a
      // half-booted/stuck QEMU process (the SMP-cap case) does not respond
      // to `adb emu kill`, so SIGKILL is the reliable path here.
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, 2000);
      resolve(result);
    };

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const match = stderrBuf.match(/Number of SMP CPUs requested \(\d+\) exceeds max CPUs supported by machine '[^']*' \((\d+)\)/);
      if (match) {
        cleanupAndResolve({
          outcome: 'smp-cap-exceeded',
          maxSmpCpus: Number(match[1]),
          message: match[0],
        });
      }
    });

    child.on('error', (err) => {
      cleanupAndResolve({ outcome: 'error', message: err.message });
    });
    child.on('exit', (code) => {
      if (!settled) {
        cleanupAndResolve({ outcome: 'error', message: `emulator exited early (code ${code}) without booting or hitting a known error` });
      }
    });

    // Poll boot_completed via adb every 3s once the process is up.
    pollTimer = setInterval(async () => {
      const out = await tryRun(adbPath, ['-s', `emulator-5554`, 'shell', 'getprop', 'sys.boot_completed']);
      if (out && out.stdout.trim() === '1') {
        cleanupAndResolve({ outcome: 'booted', message: 'sys.boot_completed=1' });
      }
    }, 3000);

    hardTimeout = setTimeout(() => {
      cleanupAndResolve({ outcome: 'timeout', message: `did not boot or fail within ${timeoutMs}ms` });
    }, timeoutMs);
  });
}
