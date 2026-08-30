#!/usr/bin/env node
/**
 * Dev helper (ticket T04 verification): launches a rig scene by id on a
 * given leg (b = Android emulator, c = iOS simulator; PLAN.md §3 naming),
 * awaits completion, pulls the results JSON, and prints it.
 *
 * Usage:
 *   node src/dev/run-scene.mjs <sceneId> --leg b|c [--durationMs 1000] [--out path]
 *
 * Requires a booted `bench-tuned`-class emulator (leg b) or a booted
 * simulator (leg c) with the rig app already installed in release
 * configuration (SPEC.md §9) -- this script only drives the deep link and
 * extracts results, it does not build or install the app.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  awaitAndPullResultsAndroid,
  awaitAndPullResultsIos,
  ensureAdbRoot,
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
  launchSceneAndroid,
  launchSceneIos,
} from '../rig-host.js';

function parseArgs(argv) {
  const [sceneId, ...rest] = argv;
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = 'true';
    }
  }
  return { sceneId, flags };
}

async function main() {
  const { sceneId, flags } = parseArgs(process.argv.slice(2));

  if (!sceneId || !flags.leg) {
    console.error('Usage: node src/dev/run-scene.mjs <sceneId> --leg b|c [--durationMs 1000] [--out path]');
    process.exit(1);
  }

  const durationMs = flags.durationMs ?? '1000';
  // `.local.json` matches the repo's `.gitignore` pattern for scratch
  // output -- this is a dev smoke-test artifact, not a schema-shaped,
  // provenance-tracked results file (those live in `results/` per T01/T13).
  const scratchDir = fileURLToPath(new URL('../../results/.scratch/', import.meta.url));
  const destPath =
    flags.out ?? path.join(scratchDir, `${sceneId.replace(/\./g, '-')}-leg-${flags.leg}.local.json`);

  if (flags.leg === 'b') {
    const serial = await firstAndroidDeviceSerial();
    if (!serial) {
      console.error('run-scene: no Android device/emulator found (adb devices returned none)');
      process.exit(1);
    }
    await ensureAdbRoot({ serial });
    const { url } = await launchSceneAndroid(sceneId, { durationMs }, { serial });
    console.error(`run-scene: launched ${url} on Android device ${serial}`);
    await awaitAndPullResultsAndroid({ serial, destPath });
  } else if (flags.leg === 'c') {
    const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
    const { url } = await launchSceneIos(sceneId, { durationMs }, { udid });
    console.error(`run-scene: launched ${url} on iOS simulator ${udid}`);
    await awaitAndPullResultsIos({ udid, destPath });
  } else {
    console.error(`run-scene: unknown --leg "${flags.leg}" (expected b or c)`);
    process.exit(1);
  }

  const resultsJson = await readFile(destPath, 'utf8');
  console.log(resultsJson);
}

main().catch((err) => {
  console.error('run-scene failed:', err);
  process.exit(1);
});
