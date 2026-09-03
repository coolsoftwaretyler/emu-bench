// @ts-check
/**
 * Host-side rig extraction helpers (SPEC.md §9, ticket T04 scope): launch a
 * scene via deep link, await completion (poll for the results file / for
 * `EMUBENCH_DONE`), and pull the results file, on both the Android emulator
 * (adb) and the iOS Simulator (simctl). Also provides release build+install
 * helpers for both platforms.
 *
 * "Leg" naming matches PLAN.md §3: leg B = Android emulator, leg C = iOS
 * simulator.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const ANDROID_APP_ID = 'com.emubench.rig';
export const IOS_BUNDLE_ID = 'com.emubench.rig';
export const RESULTS_FILENAME = 'embench-results.json';

/**
 * Builds the `emubench://scene/<id>?...` deep link for a scene id + params.
 * @param {string} sceneId
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function buildSceneUrl(sceneId, params = {}) {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return query.length > 0
    ? `emubench://scene/${sceneId}?${query}`
    : `emubench://scene/${sceneId}`;
}

// --- Android (leg B) ---------------------------------------------------

/**
 * @param {string[]} args
 * @param {{ serial?: string }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function adb(args, { serial } = {}) {
  const fullArgs = serial ? ['-s', serial, ...args] : args;
  return execFileAsync('adb', fullArgs);
}

/**
 * Returns the serial of a connected Android device, preferring an
 * `emulator-*` serial (leg B, PLAN.md §3) over a physical device that
 * happens to also be attached (e.g. over adb-over-wifi) -- this suite
 * never targets real devices (SPEC.md §3 non-goals).
 * @returns {Promise<string|null>}
 */
export async function firstAndroidDeviceSerial() {
  const { stdout } = await adb(['devices']);
  const lines = stdout.split('\n').slice(1);
  /** @type {string[]} */
  const serials = [];
  for (const line of lines) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state === 'device') serials.push(serial);
  }
  return serials.find((s) => s.startsWith('emulator-')) ?? serials[0] ?? null;
}

/**
 * Launches a scene on Android via `adb shell am start -W -a
 * android.intent.action.VIEW -d <url>` (SPEC.md §9 scene routing).
 *
 * Removes any pre-existing results file first (best-effort -- ignores
 * failure, e.g. first-ever run when the file doesn't exist yet) so a
 * caller polling for the file afterward cannot mistake a stale result
 * left over from a previous scene run for this run's output.
 * @param {string} sceneId
 * @param {Record<string, string|number>} params
 * @param {{ serial?: string }} [opts]
 */
export async function launchSceneAndroid(sceneId, params, opts = {}) {
  const remotePath = `/data/data/${ANDROID_APP_ID}/files/${RESULTS_FILENAME}`;
  await adb(['shell', 'rm', '-f', remotePath], opts).catch(() => {});

  const url = buildSceneUrl(sceneId, params);
  const { stdout } = await adb(
    ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url],
    opts,
  );
  return { url, amStartOutput: stdout };
}

/**
 * Polls (via `adb shell run-as ... ls`, falling back to logcat for
 * `EMUBENCH_DONE`) until the results file exists in the app's files dir,
 * then pulls it to `destPath` via `adb pull` (SPEC.md §9 result
 * extraction). Times out after `timeoutMs`.
 * @param {{ serial?: string, destPath: string, timeoutMs?: number, pollIntervalMs?: number }} args
 */
export async function awaitAndPullResultsAndroid({
  serial,
  destPath,
  timeoutMs = 30_000,
  pollIntervalMs = 500,
}) {
  const remotePath = `/data/data/${ANDROID_APP_ID}/files/${RESULTS_FILENAME}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // `run-as` requires a debuggable app OR root adb; bench AVDs use
      // Google-APIs images with `adb root` (SPEC.md §6 / PLAN.md glossary),
      // so we go straight through root-adb `ls` rather than `run-as`.
      await adb(['shell', 'ls', remotePath], { serial });
      break; // file exists
    } catch {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  if (Date.now() >= deadline) {
    throw new Error(
      `awaitAndPullResultsAndroid: timed out waiting for ${remotePath} after ${timeoutMs}ms`,
    );
  }

  await mkdir(path.dirname(destPath), { recursive: true });
  await adb(['pull', remotePath, destPath], { serial });
  return destPath;
}

/**
 * Ensures adb is rooted (needed to read another app's files dir without
 * `run-as`) -- bench AVDs use Google-APIs system images which permit this
 * (SPEC.md §6, PLAN.md glossary "system image").
 * @param {{ serial?: string }} [opts]
 */
export async function ensureAdbRoot(opts = {}) {
  await adb(['root'], opts);
  // adb root restarts the adbd daemon; give it a moment to come back.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await adb(['shell', 'true'], opts);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('ensureAdbRoot: adb did not come back after `adb root`');
}

/**
 * Builds the Android release APK via Gradle (`assembleRelease`), returning
 * the built APK's path.
 * @param {{ rigDir: string, androidHome?: string }} args
 */
export async function buildAndroidRelease({ rigDir, androidHome }) {
  const androidDir = path.join(rigDir, 'android');
  await execAsync('./gradlew', ['assembleRelease'], {
    cwd: androidDir,
    env: androidHome ? { ...process.env, ANDROID_HOME: androidHome } : process.env,
  });
  return path.join(androidDir, 'app/build/outputs/apk/release/app-release.apk');
}

/**
 * Installs an APK onto the given (or first available) Android device.
 * @param {string} apkPath
 * @param {{ serial?: string }} [opts]
 */
export async function installAndroidApk(apkPath, opts = {}) {
  await adb(['install', '-r', apkPath], opts);
}

// --- iOS (leg C) ---------------------------------------------------------

/**
 * Returns the UDID of the first booted simulator, or null.
 * @returns {Promise<string|null>}
 */
export async function firstBootedSimulatorUdid() {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  const parsed = JSON.parse(stdout);
  for (const runtime of Object.values(parsed.devices)) {
    for (const device of /** @type {any[]} */ (runtime)) {
      if (device.state === 'Booted') return device.udid;
    }
  }
  return null;
}

/**
 * Launches a scene on iOS via `xcrun simctl openurl` (SPEC.md §9 scene
 * routing).
 *
 * Removes any pre-existing results file first (best-effort -- ignores
 * failure, e.g. first-ever run when the file doesn't exist yet) so a
 * caller polling for the file afterward cannot mistake a stale result
 * left over from a previous scene run for this run's output.
 * @param {string} sceneId
 * @param {Record<string, string|number>} params
 * @param {{ udid?: string }} [opts]
 */
export async function launchSceneIos(sceneId, params, { udid = 'booted' } = {}) {
  try {
    const { stdout } = await execFileAsync('xcrun', [
      'simctl',
      'get_app_container',
      udid,
      IOS_BUNDLE_ID,
      'data',
    ]);
    const resultsPath = path.join(stdout.trim(), 'Documents', RESULTS_FILENAME);
    await rm(resultsPath, { force: true });
  } catch {
    // App not installed yet, or no prior results file -- fine either way.
  }

  const url = buildSceneUrl(sceneId, params);
  await execFileAsync('xcrun', ['simctl', 'openurl', udid, url]);
  return { url };
}

/**
 * Polls the app's container (via `simctl get_app_container ... data` +
 * checking the file on disk directly -- CoreSimulator apps are plain files
 * on the host, SPEC.md §9 glossary "CoreSimulator") until the results file
 * exists, then copies it to `destPath`.
 * @param {{ udid?: string, destPath: string, timeoutMs?: number, pollIntervalMs?: number }} args
 */
export async function awaitAndPullResultsIos({
  udid = 'booted',
  destPath,
  timeoutMs = 30_000,
  pollIntervalMs = 500,
}) {
  const { stdout } = await execFileAsync('xcrun', [
    'simctl',
    'get_app_container',
    udid,
    IOS_BUNDLE_ID,
    'data',
  ]);
  const containerPath = stdout.trim();
  const resultsPath = path.join(containerPath, 'Documents', RESULTS_FILENAME);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(resultsPath, 'utf8');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  if (Date.now() >= deadline) {
    throw new Error(
      `awaitAndPullResultsIos: timed out waiting for ${resultsPath} after ${timeoutMs}ms`,
    );
  }

  await mkdir(path.dirname(destPath), { recursive: true });
  const contents = await readFile(resultsPath, 'utf8');
  await rm(destPath, { force: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(destPath, contents, 'utf8');
  return destPath;
}

/**
 * Builds the iOS release build via xcodebuild for a given simulator UDID,
 * returning the built .app's path.
 * @param {{ rigDir: string, udid: string }} args
 */
export async function buildIosRelease({ rigDir, udid }) {
  const iosDir = path.join(rigDir, 'ios');
  const derivedDataPath = path.join(iosDir, 'build');
  await execAsync(
    'xcodebuild',
    [
      '-workspace',
      'RigApp.xcworkspace',
      '-scheme',
      'RigApp',
      '-configuration',
      'Release',
      '-destination',
      `platform=iOS Simulator,id=${udid}`,
      '-derivedDataPath',
      derivedDataPath,
      'build',
    ],
    { cwd: iosDir },
  );
  return path.join(derivedDataPath, 'Build/Products/Release-iphonesimulator/RigApp.app');
}

/**
 * Installs a built .app onto the given (or 'booted') simulator.
 * @param {string} appPath
 * @param {{ udid?: string }} [opts]
 */
export async function installIosApp(appPath, { udid = 'booted' } = {}) {
  await execFileAsync('xcrun', ['simctl', 'install', udid, appPath]);
}

// --- shared --------------------------------------------------------------

/**
 * Runs a command to completion, streaming its output to the parent
 * process's stdout/stderr (useful for long-running builds where the
 * caller wants to see progress), and rejects on non-zero exit.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
function execAsync(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...opts, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}
