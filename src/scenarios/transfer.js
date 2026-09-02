// @ts-check
/**
 * Transfer scenario (PLAN.md §4 Group 6, H8; SPEC.md §11; ticket T10
 * scope). "500 MB generated file, `adb push` MB/s vs `cp` into
 * `simctl get_app_container` path" -- directly measures the transport tax
 * (PLAN.md glossary "user-mode networking (slirp-style)": `adb push`
 * rides on it) against a plain file copy into the simulator's container
 * (CoreSimulator apps share the host filesystem, PLAN.md §3, so `cp` is
 * the honest iOS equivalent -- there is no transport to tax).
 *
 * Registers one BenchmarkEntry, `transfer.push`, legs b/c, unit MB/s
 * (higher is better -- the one Group 6 row that isn't a duration; noted
 * so aggregate/writeup code doesn't assume every Group 6 unit is
 * seconds).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, mkdir, stat, access, constants as fsConstants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomFillSync } from 'node:crypto';

import { register } from '../registry.js';
import {
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
  IOS_BUNDLE_ID,
} from '../rig-host.js';
import { ensureEmulatorRunning } from './boot.js';

const execFileAsync = promisify(execFile);

const scratchDir = fileURLToPath(new URL('../../results/.scratch/', import.meta.url));
const BLOB_FILENAME = 'transfer-blob.local.bin'; // matches top-level .gitignore's *.local.bin pattern

const DEVICE_PUSH_PATH = '/data/local/tmp/embench-transfer-blob';

/** PLAN.md §4 Group 6 / Appendix Phase-0 command: "500 MB". */
const BLOB_BYTES = 500 * 1024 * 1024;
/** Ticket scope: "n>=10 unless noted" (PLAN.md §5 macro floor). */
const TRANSFER_N = 10;

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
 * @returns {Promise<string>}
 */
async function resolveEmulatorSerial() {
  await ensureEmulatorRunning();
  const serial = await firstAndroidDeviceSerial();
  if (serial && serial.startsWith('emulator-')) return serial;
  throw new Error(
    `transfer.push: no Android emulator device found in \`adb devices\` after ensureEmulatorRunning() (got "${serial ?? 'none'}") -- ` +
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
 * Generates (once; reused across iterations -- the file's *content*
 * doesn't affect transfer speed, so regenerating 500 MB of random bytes
 * per iteration would only slow the scenario down for no measurement
 * benefit) a 500 MB file of random bytes at `results/.scratch/` (matching
 * src/rig-scenes.js's scratch-dir precedent for non-schema dev/scenario
 * artifacts), matching PLAN.md Appendix's `dd if=/dev/urandom ... bs=1m
 * count=500` Phase-0 precedent in spirit (random, not all-zero, so it
 * isn't trivially compressible/sparse on either transport).
 * @returns {Promise<string>} absolute path to the generated blob
 */
async function ensureBlob() {
  await mkdir(scratchDir, { recursive: true });
  const blobPath = path.join(scratchDir, BLOB_FILENAME);
  if (await fileExists(blobPath)) {
    const { size } = await stat(blobPath);
    if (size === BLOB_BYTES) return blobPath;
  }
  // Fill in 16 MB chunks -- randomFillSync has a per-call byte-length cap
  // well above this, but chunking keeps peak memory bounded regardless
  // and mirrors how a real file of this size would be streamed.
  const CHUNK_BYTES = 16 * 1024 * 1024;
  const { open } = await import('node:fs/promises');
  const handle = await open(blobPath, 'w');
  try {
    let written = 0;
    while (written < BLOB_BYTES) {
      const thisChunk = Math.min(CHUNK_BYTES, BLOB_BYTES - written);
      const buf = Buffer.alloc(thisChunk);
      randomFillSync(buf);
      await handle.write(buf);
      written += thisChunk;
    }
  } finally {
    await handle.close();
  }
  return blobPath;
}

/**
 * @param {string} serial
 * @returns {Promise<number>} MB/s for one `adb push` of the 500 MB blob.
 */
async function timedAdbPush(serial) {
  const blobPath = await ensureBlob();
  await execFileAsync('adb', ['-s', serial, 'shell', 'rm', '-f', DEVICE_PUSH_PATH]).catch(() => {});
  const startedAt = Date.now();
  await execFileAsync('adb', ['-s', serial, 'push', blobPath, DEVICE_PUSH_PATH], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const elapsedS = (Date.now() - startedAt) / 1000;
  return BLOB_BYTES / 1024 / 1024 / elapsedS;
}

/**
 * @param {string} udid
 * @returns {Promise<number>} MB/s for one `cp` into the booted
 *   simulator's rig app container -- reuses the rig's own app id as the
 *   destination container purely as a filesystem target that already
 *   exists on a booted simulator; this scenario doesn't launch or
 *   otherwise involve the rig app itself.
 */
async function timedCpIntoSimulator(udid) {
  const blobPath = await ensureBlob();
  const { stdout } = await execFileAsync('xcrun', [
    'simctl',
    'get_app_container',
    udid,
    IOS_BUNDLE_ID,
    'data',
  ]);
  const destPath = path.join(stdout.trim(), 'Documents', 'embench-transfer-blob.local.bin');
  await rm(destPath, { force: true });
  const startedAt = Date.now();
  await execFileAsync('cp', [blobPath, destPath]);
  const elapsedS = (Date.now() - startedAt) / 1000;
  await rm(destPath, { force: true });
  return BLOB_BYTES / 1024 / 1024 / elapsedS;
}

/**
 * Registers `transfer.push` (PLAN.md §4 Group 6). Called as a side effect
 * of importing this module from run.js, matching src/kernels.js's
 * `registerKernelBenchmarks()` precedent.
 */
export function registerTransferBenchmarks() {
  register({
    id: 'transfer.push',
    group: 6,
    legs: ['b', 'c'],
    kind: 'macro',
    unit: 'mb_per_s',
    async run(ctx) {
      if (ctx.leg === 'b') {
        const serial = await resolveEmulatorSerial();
        /** @type {number[]} */
        const samples = [];
        for (let i = 0; i < TRANSFER_N; i++) {
          samples.push(await timedAdbPush(serial));
        }
        return samples;
      }
      if (ctx.leg === 'c') {
        const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
        // The rig app's container must exist to `get_app_container`
        // against -- if it isn't installed on this simulator yet, that's
        // a genuine precondition failure (install.rig covers install
        // separately); surface a clear reason rather than a raw simctl
        // error.
        try {
          await execFileAsync('xcrun', ['simctl', 'get_app_container', udid, IOS_BUNDLE_ID, 'data']);
        } catch {
          throw new Error(
            `transfer.push: rig app (${IOS_BUNDLE_ID}) is not installed on simulator ${udid} -- install it first (install.rig)`,
          );
        }
        /** @type {number[]} */
        const samples = [];
        for (let i = 0; i < TRANSFER_N; i++) {
          samples.push(await timedCpIntoSimulator(udid));
        }
        return samples;
      }
      throw new Error(`transfer.push: unsupported leg "${ctx.leg}"`);
    },
  });
}
