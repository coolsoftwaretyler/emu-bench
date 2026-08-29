// @ts-check
/**
 * `emu-bench doctor` (SPEC.md §5 table, §6 AVD definitions, ticket T02).
 * Answers "can this Mac run the suite?": detects every row of the SPEC §5
 * check table, auto-fixes what it safely can (printing the exact command
 * first), prints exact manual instructions for what it can't, creates the
 * `bench-tuned`/`bench-default` AVDs, and renders a per-leg/per-group
 * readiness grid. `--json` emits the same facts as machine-readable output
 * for the orchestrator to consume when deciding skips.
 */

import { isAppleSilicon } from '../arm64-gate.js';
import { captureMachine, captureToolchain } from '../provenance.js';
import {
  locateAndroidTools,
  checkLicensesAccepted,
  findLatestStableGoogleApisArm64,
  findNdkVersions,
  installSdkPackage,
  createAvdIfMissing,
  readAvdConfig,
  applyConfigOverrides,
  bootProbe,
} from '../android-sdk.js';

const TUNED_AVD_NAME = 'bench-tuned';
const DEFAULT_AVD_NAME = 'bench-default';
// SPEC.md §6 "Default AVD": "created via avdmanager with the pixel-class
// device profile" — `pixel` is avdmanager's own generic Pixel profile id
// (see `avdmanager list device`), used unmodified for both AVDs so the only
// difference between tuned and default is config.ini, not device geometry.
const PIXEL_DEVICE_PROFILE = 'pixel';

/**
 * One row of the SPEC §5 table.
 * @typedef {Object} CheckResult
 * @property {string} name
 * @property {'ok'|'fixed'|'fail'|'skip'} status
 * @property {string} detail
 * @property {string[]} [instructions] manual steps to print when not auto-fixable
 */

/**
 * @param {{ json?: boolean }} flags
 */
export async function doctorCommand(flags = {}) {
  const asJson = Boolean(flags.json);
  /** @type {CheckResult[]} */
  const checks = [];

  // --- 1. Arm64 hard gate (SPEC §5 row 1) ---
  const arm64Ok = isAppleSilicon();
  checks.push({
    name: 'Apple Silicon (arm64)',
    status: arm64Ok ? 'ok' : 'fail',
    detail: arm64Ok ? 'sysctl hw.optional.arm64 = 1' : 'sysctl hw.optional.arm64 != 1',
    instructions: arm64Ok ? undefined : ['emu-bench requires Apple Silicon; see SPEC.md §3.'],
  });
  if (!arm64Ok) {
    // Every other check is moot on Intel; report immediately (SPEC §3: hard
    // refusal, not a degraded grid).
    printHuman(
      checks,
      { legA: false, legB: false, legC: false, groupsAvailable: [] },
      { stream: asJson ? console.error : console.log },
    );
    if (asJson) printJson(checks, { legA: false, legB: false, legC: false }, {}, {});
    process.exit(1);
  }

  // Machine/toolchain facts reuse the same provenance capture that `run`
  // stamps into results files, so doctor and results never disagree about
  // what's installed.
  const [machine, toolchain] = await Promise.all([captureMachine(), captureToolchain()]);

  // --- 2. Xcode + newest iOS runtime + device type (SPEC §5 row 2) ---
  const xcodeOk = toolchain.xcode !== 'not installed';
  const iosRuntimeOk = toolchain.iosRuntime !== 'not installed';
  checks.push({
    name: 'Xcode + newest iOS runtime + device type',
    status: xcodeOk && iosRuntimeOk ? 'ok' : 'fail',
    detail: xcodeOk
      ? `Xcode ${toolchain.xcode}, runtime ${toolchain.iosRuntime}, device type ${toolchain.deviceType}`
      : 'Xcode not found',
    instructions:
      xcodeOk && iosRuntimeOk
        ? undefined
        : [
            'Install/upgrade Xcode from the App Store, then run:',
            '  xcode-select --install',
            '  sudo xcodebuild -runFirstLaunch',
            'and install the newest iOS simulator runtime from Xcode > Settings > Platforms.',
          ],
  });
  const legCReady = xcodeOk && iosRuntimeOk;

  // --- 3. ANDROID_HOME / sdkmanager / emulator / adb (SPEC §5 row 3) ---
  const tools = await locateAndroidTools();
  const androidToolsOk = Boolean(tools.androidHome && tools.sdkmanagerPath && tools.emulatorPath && tools.adbPath);
  checks.push({
    name: 'ANDROID_HOME, sdkmanager, emulator, adb',
    status: androidToolsOk ? 'ok' : 'fail',
    detail: androidToolsOk
      ? `ANDROID_HOME=${tools.androidHome}`
      : describeMissingAndroidTools(tools),
    instructions: androidToolsOk
      ? undefined
      : [
          'Install Android Studio (or just the command-line tools), then:',
          '  export ANDROID_HOME="$HOME/Library/Android/sdk"',
          '  export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"',
          'Add those exports to your shell profile (~/.zshrc) so they persist.',
        ],
  });

  // --- License pre-check (gates system-image + NDK auto-installs) ---
  let licensesOk = false;
  if (tools.androidHome) {
    const licenseCheck = await checkLicensesAccepted(tools.androidHome);
    licensesOk = licenseCheck.accepted;
    if (!licensesOk) {
      checks.push({
        name: 'Android SDK licenses accepted',
        status: 'fail',
        detail: `not accepted: ${licenseCheck.missing.join(', ')}`,
        instructions: [
          'Accept the SDK licenses (interactive — doctor will not run this for you):',
          `  ${tools.sdkmanagerPath ?? 'sdkmanager'} --licenses`,
        ],
      });
    }
  }

  // --- 4. Latest stable google_apis arm64 system image (SPEC §5 row 4) ---
  let systemImageStatus = /** @type {CheckResult} */ ({
    name: 'Latest stable google_apis arm64 system image',
    status: 'fail',
    detail: 'ANDROID_HOME/sdkmanager not available — see above',
  });
  /** @type {string|null} */
  let resolvedImageId = null;
  if (tools.androidHome && tools.sdkmanagerPath) {
    const latest = await findLatestStableGoogleApisArm64(tools.sdkmanagerPath);
    if (!latest.id) {
      systemImageStatus = {
        name: 'Latest stable google_apis arm64 system image',
        status: 'fail',
        detail: 'could not determine latest stable image from `sdkmanager --list --channel=0`',
      };
    } else {
      resolvedImageId = latest.id;
      const currentlyInstalled = toolchain.systemImage;
      const isStale = currentlyInstalled !== latest.id;
      if (!isStale) {
        systemImageStatus = {
          name: 'Latest stable google_apis arm64 system image',
          status: 'ok',
          detail: `up to date: ${latest.id}`,
        };
      } else if (!licensesOk) {
        systemImageStatus = {
          name: 'Latest stable google_apis arm64 system image',
          status: 'fail',
          detail: `stale (installed: ${currentlyInstalled}, latest: ${latest.id}); licenses not accepted, not installing`,
        };
      } else {
        const install = await installSdkPackage(tools.sdkmanagerPath, latest.id);
        systemImageStatus = {
          name: 'Latest stable google_apis arm64 system image',
          status: install.ok ? 'fixed' : 'fail',
          detail: install.message,
        };
      }
    }
  }
  checks.push(systemImageStatus);

  // --- 5. NDK (SPEC §5 row 5) ---
  let ndkStatus = /** @type {CheckResult} */ ({
    name: 'NDK (for kernel builds, leg B)',
    status: 'fail',
    detail: 'ANDROID_HOME/sdkmanager not available — see above',
  });
  if (tools.androidHome && tools.sdkmanagerPath) {
    const ndkVersions = await findNdkVersions(tools.sdkmanagerPath);
    if (ndkVersions.installedNewest) {
      ndkStatus = { name: 'NDK (for kernel builds, leg B)', status: 'ok', detail: `installed: ndk;${ndkVersions.installedNewest}` };
    } else if (!ndkVersions.availableNewest) {
      ndkStatus = { name: 'NDK (for kernel builds, leg B)', status: 'fail', detail: 'could not determine an available NDK version' };
    } else if (!licensesOk) {
      ndkStatus = { name: 'NDK (for kernel builds, leg B)', status: 'fail', detail: 'not installed; licenses not accepted, not installing' };
    } else {
      const install = await installSdkPackage(tools.sdkmanagerPath, `ndk;${ndkVersions.availableNewest}`);
      ndkStatus = { name: 'NDK (for kernel builds, leg B)', status: install.ok ? 'fixed' : 'fail', detail: install.message };
    }
  }
  checks.push(ndkStatus);

  // --- 6. AVDs bench-tuned / bench-default (SPEC §5 row 6, §6) ---
  const avdCheck = await ensureAvds({ tools, resolvedImageId, toolchain });
  checks.push(avdCheck.check);

  // --- 7. Maestro (SPEC §5 row 7) ---
  const maestroOk = toolchain.maestro !== 'not installed';
  checks.push({
    name: 'Maestro',
    status: maestroOk ? 'ok' : 'fail',
    detail: maestroOk ? `maestro ${toolchain.maestro}` : 'not found on PATH',
    instructions: maestroOk ? undefined : ['brew tap mobile-dev-inc/tap && brew install maestro'],
  });

  // --- 8. ffmpeg (SPEC §5 row 8, input-to-photon secondary only) ---
  const ffmpegOk = await checkFfmpeg();
  checks.push({
    name: 'ffmpeg (input-to-photon secondary only)',
    status: ffmpegOk ? 'ok' : 'fail',
    detail: ffmpegOk ? 'found on PATH' : 'not found on PATH',
    instructions: ffmpegOk ? undefined : ['brew install ffmpeg'],
  });

  // --- 9. sudo note for Group 7 (SPEC §5 row 9) — informational only ---
  checks.push({
    name: 'sudo for powermetrics (Group 7 only)',
    status: 'skip',
    detail: 'not checked here — `run` prompts (`sudo -v`) immediately before Group 7, per SPEC §11.',
  });

  // --- Readiness: per-leg, per-group (SPEC §5, §1) ---
  const legA = true; // native macOS leg always runs once arm64-gated
  // NDK gates leg B too, not just AVD/image: the check's own name says "for
  // kernel builds, leg B" (SPEC §8's Group 1 kernel suite is built via NDK
  // clang for the android target), and Group 1 sits inside the "legs A+B+C
  // runnable for Groups 1-6" exit-0 bar (SPEC §5) — so a machine with no
  // usable NDK cannot actually run leg B's kernel build, even if the
  // emulator itself boots fine.
  const legB =
    androidToolsOk &&
    licensesOk &&
    systemImageStatus.status !== 'fail' &&
    ndkStatus.status !== 'fail' &&
    avdCheck.avdsReady;
  const legC = legCReady;
  const groupsAvailable = computeGroupsAvailable({ legA, legB, legC });

  // `--json` output must be clean JSON on stdout for the orchestrator to
  // parse (ticket line 17: "machine-readable output the orchestrator
  // consumes to decide skips") — so the human grid goes to stderr instead
  // of stdout when `--json` is requested, never interleaved with the JSON.
  printHuman(checks, { legA, legB, legC, groupsAvailable }, { stream: asJson ? console.error : console.log });

  const avdConfigs = avdCheck.configs;
  if (asJson) {
    printJson(checks, { legA, legB, legC }, avdConfigs, {
      systemImageResolved: resolvedImageId,
    });
  }

  // Exit code 0 = at least legs A+B+C runnable for Groups 1-6 (SPEC §5).
  const groups1to6 = [1, 2, 3, 4, 5, 6];
  const allGroups1to6Ready = groups1to6.every((g) => groupsAvailable.includes(g));
  const ready = legA && legB && legC && allGroups1to6Ready;
  process.exit(ready ? 0 : 1);
}

/**
 * @param {{ androidHome: string|null, sdkmanagerPath: string|null, avdmanagerPath: string|null, emulatorPath: string|null, adbPath: string|null }} tools
 * @returns {string}
 */
function describeMissingAndroidTools(tools) {
  const missing = [];
  if (!tools.androidHome) missing.push('ANDROID_HOME unset');
  if (tools.androidHome && !tools.sdkmanagerPath) missing.push('sdkmanager not found under cmdline-tools/');
  if (!tools.emulatorPath) missing.push('emulator not found');
  if (!tools.adbPath) missing.push('adb not found');
  return missing.join('; ');
}

async function checkFfmpeg() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('ffmpeg', ['-version'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates both AVDs (idempotent) and records their effective config.ini for
 * provenance (ticket line 15, SPEC §6/§7).
 * @param {{ tools: any, resolvedImageId: string|null, toolchain: any }} args
 */
async function ensureAvds({ tools, resolvedImageId, toolchain }) {
  if (!tools.androidHome || !tools.avdmanagerPath) {
    return {
      check: /** @type {CheckResult} */ ({
        name: `AVDs ${TUNED_AVD_NAME} and ${DEFAULT_AVD_NAME}`,
        status: 'fail',
        detail: 'avdmanager not available — see ANDROID_HOME check above',
      }),
      avdsReady: false,
      configs: { avdTuned: {}, avdDefault: {} },
    };
  }

  // Prefer the freshly-resolved latest-stable image id; fall back to
  // whatever provenance found already installed (covers the case where the
  // image check ran but this function is invoked independently in tests).
  const packageId = resolvedImageId ?? (toolchain.systemImage !== 'not installed' ? toolchain.systemImage : null);
  if (!packageId) {
    return {
      check: /** @type {CheckResult} */ ({
        name: `AVDs ${TUNED_AVD_NAME} and ${DEFAULT_AVD_NAME}`,
        status: 'fail',
        detail: 'no google_apis arm64 system image available to create AVDs from',
      }),
      avdsReady: false,
      configs: { avdTuned: {}, avdDefault: {} },
    };
  }

  // SPEC §6 tuned AVD: ncore = P-core count (sysctl hw.perflevel0.logicalcpu,
  // computed per machine), ramSize 8192.
  const pCores = await getPCoreCount();
  const tunedOverrides = {
    'hw.cpu.ncore': String(pCores),
    'hw.ramSize': '8192',
  };

  const tunedResult = await createAvdIfMissing(tools.avdmanagerPath, {
    name: TUNED_AVD_NAME,
    packageId,
    device: PIXEL_DEVICE_PROFILE,
    extraConfig: tunedOverrides,
  });

  const defaultResult = await createAvdIfMissing(tools.avdmanagerPath, {
    name: DEFAULT_AVD_NAME,
    packageId,
    device: PIXEL_DEVICE_PROFILE,
    // No extraConfig — SPEC §6: "unmodified config.ini"; whatever
    // avdmanager's own defaults are IS the measurement.
  });

  // Boot-verify bench-tuned once, only right after it's freshly created
  // (ticket line "boot bench-tuned once to confirm it starts" — doing this
  // on every doctor run would break the idempotent-and-fast re-run
  // contract). This machine's finding: a 12-P-core Mac against Android
  // Emulator 37.1.11.0 hits QEMU's `mach-virt` cap of 8 vCPUs when
  // hw.cpu.ncore is set to the P-core count uncapped per SPEC §6 — the
  // guest never boots (SMP CPUs requested (12) exceeds max CPUs supported
  // by machine 'mach-virt' (8)). Detected and clamped here, once, with the
  // clamp recorded rather than silently chosen: SPEC §6's intent (native
  // parallelism) is preserved up to whatever this emulator build can
  // actually run.
  let clampNote = '';
  if (tunedResult.created && tools.emulatorPath && tools.adbPath) {
    const probe = await bootProbe({
      emulatorPath: tools.emulatorPath,
      adbPath: tools.adbPath,
      avdName: TUNED_AVD_NAME,
    });
    if (probe.outcome === 'smp-cap-exceeded' && probe.maxSmpCpus) {
      // stderr, not stdout — `doctor --json` must have pure JSON on stdout
      // even on this exact path (a fresh AVD hitting the SMP cap on first
      // boot-verify), so this progress line can never land on stdout.
      console.error(
        `emu-bench doctor: bench-tuned failed to boot with hw.cpu.ncore=${pCores} ` +
          `(${probe.message}). Clamping to ${probe.maxSmpCpus} (this emulator build's ` +
          `mach-virt vCPU limit) and re-verifying.`,
      );
      await applyConfigOverrides(TUNED_AVD_NAME, { 'hw.cpu.ncore': String(probe.maxSmpCpus) });
      const reprobe = await bootProbe({
        emulatorPath: tools.emulatorPath,
        adbPath: tools.adbPath,
        avdName: TUNED_AVD_NAME,
      });
      clampNote =
        reprobe.outcome === 'booted'
          ? ` [hw.cpu.ncore clamped from host P-core count ${pCores} to ${probe.maxSmpCpus}: this emulator build's mach-virt vCPU limit — boot verified after clamp]`
          : ` [hw.cpu.ncore clamped to ${probe.maxSmpCpus} but re-verification did not report success: ${reprobe.message}]`;
    } else if (probe.outcome === 'booted') {
      clampNote = ' [boot verified]';
    } else {
      clampNote = ` [boot verification inconclusive: ${probe.outcome} — ${probe.message}]`;
    }
  }

  const [avdTuned, avdDefault] = await Promise.all([
    readAvdConfig(TUNED_AVD_NAME),
    readAvdConfig(DEFAULT_AVD_NAME),
  ]);

  const ok = tunedResult.ok && defaultResult.ok && Object.keys(avdTuned).length > 0 && Object.keys(avdDefault).length > 0;
  const anyCreated = tunedResult.created || defaultResult.created;
  return {
    check: /** @type {CheckResult} */ ({
      name: `AVDs ${TUNED_AVD_NAME} and ${DEFAULT_AVD_NAME}`,
      status: ok ? (anyCreated ? 'fixed' : 'ok') : 'fail',
      detail: `${tunedResult.message}; ${defaultResult.message}${clampNote}`,
    }),
    avdsReady: ok,
    configs: { avdTuned, avdDefault },
  };
}

async function getPCoreCount() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('sysctl', ['-n', 'hw.perflevel0.logicalcpu'], { encoding: 'utf8' });
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {{ legA: boolean, legB: boolean, legC: boolean }} legs
 * @returns {number[]} groups runnable given which legs are ready. Groups 1-5
 *   need all three legs (native/emulator/simulator comparison per SPEC §1);
 *   Group 6 (dev-loop) needs B+C; Group 7 (host cost) needs B+C too.
 *   (SPEC §5: "at least legs A+B+C runnable for Groups 1-6" is the exit-0
 *   bar, so 1-6 all require the full trio here.)
 */
function computeGroupsAvailable({ legA, legB, legC }) {
  const groups = [];
  if (legA && legB && legC) groups.push(1, 2, 3, 4, 5, 6);
  if (legB && legC) groups.push(7);
  return groups;
}

/**
 * @param {CheckResult[]} checks
 * @param {{ legA: boolean, legB: boolean, legC: boolean, groupsAvailable: number[] }} readiness
 * @param {{ stream?: (...args: any[]) => void }} [opts] `stream` defaults to
 *   `console.log`; pass `console.error` to keep stdout clean for `--json`.
 */
function printHuman(checks, readiness, opts = {}) {
  const log = opts.stream ?? console.log;
  log('emu-bench doctor — SPEC.md §5 preflight\n');
  const symbol = { ok: 'OK', fixed: 'FIXED', fail: 'FAIL', skip: '--' };
  for (const c of checks) {
    log(`[${symbol[c.status]}] ${c.name}`);
    log(`       ${c.detail}`);
    if (c.instructions) {
      for (const line of c.instructions) log(`       ${line}`);
    }
  }
  log('\nReadiness grid:');
  log(`  Leg A (macOS native):     ${readiness.legA ? 'ready' : 'NOT ready'}`);
  log(`  Leg B (Android emulator): ${readiness.legB ? 'ready' : 'NOT ready'}`);
  log(`  Leg C (iOS Simulator):    ${readiness.legC ? 'ready' : 'NOT ready'}`);
  const allGroups = [1, 2, 3, 4, 5, 6, 7];
  const unavailable = allGroups.filter((g) => !readiness.groupsAvailable.includes(g));
  if (unavailable.length === 0) {
    log('  Groups 1-7: all available');
  } else {
    log(`  Groups available: ${readiness.groupsAvailable.join(', ') || 'none'}`);
    log(`  Groups unavailable: ${unavailable.join(', ')}`);
    const unreadyLegs = ['legA', 'legB', 'legC'].filter((l) => !readiness[/** @type {'legA'|'legB'|'legC'} */ (l)]);
    if (unreadyLegs.length > 0) {
      log(`  (blocked by: ${unreadyLegs.join(', ')} not ready)`);
    }
  }
}

/**
 * @param {CheckResult[]} checks
 * @param {{ legA: boolean, legB: boolean, legC: boolean }} legs
 * @param {{ avdTuned: Record<string,string>, avdDefault: Record<string,string> }} avdConfigs
 * @param {{ systemImageResolved: string|null }} extra
 */
function printJson(checks, legs, avdConfigs, extra) {
  const groupsAvailable = computeGroupsAvailable(legs);
  const output = {
    checks: checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
    legs,
    groupsAvailable,
    avdConfigs,
    systemImageResolved: extra.systemImageResolved ?? null,
  };
  console.log(JSON.stringify(output, null, 2));
}
