// @ts-check
/**
 * Group 4 input-to-photon SECONDARY registry integration (PLAN.md §4 Group
 * 4 "Input-to-photon, secondary (end-to-end)", SPEC.md §10, ticket T09).
 * Registers one BenchmarkEntry, `photon.latency`, group 4, legs b/c only
 * (SPEC.md §10: "no leg-A analog" -- there is no native-Mac window to
 * screen-record against).
 *
 * End-to-end pipeline per leg:
 *   1. Resolve the device-window screen region (see `resolveRegion`):
 *      `--region x,y,w,h` override > a saved one-time calibration >
 *      best-effort auto-detect (CoreGraphics window list, then
 *      `osascript`/System Events). Ticket: "device window region located
 *      automatically if cheap ... or via a one-time calibration step that
 *      saves the region to the run config."
 *   2. Launch T07's `touch.latency` scene fresh (no Maestro flow this
 *      time -- see file doc below for why this module drives taps itself
 *      rather than reusing flows/touch-latency.yaml).
 *   3. Start an `ffmpeg -f avfoundation` 60fps screen recording of the
 *      whole display (crop happens at analysis time, not capture time --
 *      simpler capture invocation, and the region is needed in *decoded*
 *      pixel space either way).
 *   4. Deliver N taps to the scene's touch target one at a time via a
 *      single-tap Maestro flow invoked once per tap, logging
 *      `Date.now()` (relative to the recording's own start) immediately
 *      around each invocation -- this is the "injected-tap timestamp
 *      logged by the driver" the ticket requires.
 *   5. Stop the recording, run `src/frame-diff.mjs`'s analyzer against it
 *      with the resolved region and the logged tap timestamps.
 *   6. Clean up the recording file; return `{samples: latencyMs[],
 *      method}` -- `method` records which detection approach was used
 *      (this module implements the "scene's high-contrast response
 *      alone" option the ticket offers, see file doc "Method" below).
 *
 * ## Method (ticket: "Choose one method, document it, record it in
 * provenance as `method`")
 *
 * Chosen: **`"scene-flash"`** -- detect TouchLatencyScene's own full-region
 * high-contrast background flip (COLOR_DARK #050505 <-> COLOR_LIGHT
 * #f5f5f5, TouchLatencyScene.tsx) directly in the device-window region,
 * rather than an added cursor-position flash marker. Reasoning: (a) T07's
 * scene already guarantees "an obvious high-contrast change" specifically
 * because "T09 reuses it for pixel-diff detection" (TouchLatencyScene.tsx's
 * own doc comment); (b) Maestro's tap injection has no on-screen OS cursor
 * to flash (a touchscreen tap is not a mouse click) -- a cursor-position
 * marker would require adding new UI to the scene or the driver with no
 * corresponding "the tap happened here" signal to flash *at*, whereas the
 * scene's own state already flips synchronously on every tap; (c) the
 * scene fills the *entire* screen with the flat color (see
 * TouchLatencyScene.tsx's `styles.container`), so detection is insensitive
 * to modest region-calibration error -- a same-sized-or-smaller region
 * still sees the same solid-color transition even if it's not perfectly
 * centered on the device window.
 *
 * ## Why this module drives taps directly rather than reusing
 * flows/touch-latency.yaml
 *
 * T07's flow (`flows/touch-latency.yaml`) delivers all 32 taps inside one
 * `maestro test` invocation's `repeat` block, with no host-visible
 * timestamp per tap -- fine for T07 (which only needs the *scene's own*
 * in-app timestamp) but insufficient here, where the ticket requires
 * "the tap timestamp logged by the driver" as one side of the latency
 * computation. `runSingleTapFlow` below invokes a tiny one-tap Maestro
 * flow once per sample, wrapping each invocation with `Date.now()` reads
 * immediately before/after -- the recorded `tapAtMs` uses the timestamp
 * taken immediately before Maestro is invoked (the earliest defensible
 * bound on "when this tap was injected"), consistent with this module
 * erring toward reporting the *photon* latency as no smaller than reality
 * (see the ticket's own sanity check: this number must be >= T07's in-app
 * number, never less).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { register } from './registry.js';
import {
  ANDROID_APP_ID,
  IOS_BUNDLE_ID,
  RESULTS_FILENAME,
  buildSceneUrl,
  ensureAdbRoot,
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
} from './rig-host.js';

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scratchDir = fileURLToPath(new URL('../results/.scratch/', import.meta.url));
const flowsDir = fileURLToPath(new URL('../flows/', import.meta.url));

/** Matches the `*.local.json` gitignore pattern already established for
 * per-machine/scratch state (results/.scratch/*.local.json) -- this file
 * caches the one-time region calibration so repeat runs on the same
 * machine skip the osascript probe (ticket: "saves the region to the run
 * config"). Deliberately at repo root, not results/, since it isn't a
 * measurement -- it's setup state, same category as an AVD config.ini. */
const REGION_CACHE_PATH = path.join(repoRoot, 'photon-region.local.json');

/** SPEC.md §10 / PLAN.md §4 Group 4: "records the Mac screen ... at 60
 * fps". Fixed, not configurable -- the ticket's quantization-honesty
 * acceptance criterion depends on this exact, known value. */
const CAPTURE_FPS = 60;

/** Method label recorded in provenance -- see file doc "Method" above. */
const METHOD = 'scene-flash';

/** Same single-emulator-instance convention as src/kernels.js / src/fence.js. */
const EMULATOR_SERIAL = 'emulator-5554';

/** >=30 per the ticket's literal acceptance criterion ("≥ 30 per-tap
 * latencies"); a couple of extra taps give headroom against occasional
 * misses/misfires without needing a retry loop. */
const DEFAULT_TAP_COUNT = 32;

/** Same cadence T07's flow uses (`flows/touch-latency.yaml`'s 1s-ish
 * interval via its extendedWaitUntil steps) -- keeps this secondary
 * metric's injection rhythm comparable to the primary metric's. */
const INTER_TAP_DELAY_MS = 1000;

/** Headroom for a single-tap `maestro test` invocation. On leg b (app
 * already foregrounded, Android keeps it that way across invocations --
 * see IOS_REENTER_SCENE_PREAMBLE's doc) this is one bare tap, comfortably
 * inside a much smaller budget than rig-scenes.js's TOUCH_LATENCY_TIMEOUT_MS
 * (which covers a full 32-tap flow in one process). On leg c, every
 * invocation also re-launches + re-navigates first (see
 * IOS_REENTER_SCENE_PREAMBLE) -- measured ~11s wall-clock for that full
 * sequence during this ticket's own live verification, so this budget is
 * sized for the more expensive leg c case; leg b finishes well under it. */
const SINGLE_TAP_TIMEOUT_MS = 30_000;

/** Headroom for scene launch + waiting for the touch target to render,
 * before any taps are sent. */
const SCENE_LAUNCH_TIMEOUT_MS = 30_000;

// --- ffmpeg presence -------------------------------------------------------

/**
 * @returns {Promise<boolean>}
 */
async function ffmpegAvailable() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

// --- region resolution ------------------------------------------------------

/**
 * `x`/`y` may legitimately be negative -- see the matching doc comment on
 * src/frame-diff.mjs's `parseRegion` for why (macOS global screen-
 * coordinate space on a multi-monitor setup; confirmed live during this
 * ticket's own verification with a genuine `-2288,-410,...` region).
 * @param {string} raw "x,y,w,h"
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function parseRegionFlag(raw) {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`photon: invalid --region "${raw}", expected "x,y,w,h"`);
  }
  const [x, y, w, h] = parts;
  if (w <= 0 || h <= 0) {
    throw new Error(`photon: --region width/height must be > 0, got "${raw}"`);
  }
  return { x, y, w, h };
}

/**
 * @returns {Promise<Record<string, {x:number,y:number,w:number,h:number}>|null>}
 */
async function readRegionCache() {
  try {
    const raw = await readFile(REGION_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string} leg
 * @param {{x:number,y:number,w:number,h:number}} region
 */
async function saveRegionToCache(leg, region) {
  const existing = (await readRegionCache()) ?? {};
  existing[leg] = region;
  await writeFile(REGION_CACHE_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

/**
 * Best-effort auto-detection of the device window's on-screen bounds via
 * the **CoreGraphics on-screen window list** (`CGWindowListCopyWindowInfo`,
 * one of the ticket's two named options: "window bounds via osascript/
 * CoreGraphics window list"), invoked through a tiny inline Swift script
 * (`swift` ships with Xcode CLT, already a hard SPEC.md §5 requirement for
 * every machine running this suite -- no new external dependency).
 * Filters to windows owned by a process whose name matches
 * `processNamePattern` (case-insensitive substring) -- `qemu-system` for
 * the Android emulator (`-gpu host`'s native window), `Simulator` for the
 * iOS Simulator app -- and returns the *largest by area* matching window,
 * since a process can own more than one on-screen window (observed
 * directly during this ticket's own development: the emulator's
 * `qemu-system-aarch64` process owned both its main ~411x759 display
 * window and a separate ~54x506 side-toolbar window; picking the larger
 * one reliably selects the actual device display).
 *
 * This is the primary auto-detect path (tried before `osascript`) because
 * `CGWindowListCopyWindowInfo`'s on-screen-window-list read does NOT
 * require Accessibility permission -- verified directly during this
 * ticket's own development on a terminal that has Screen-Recording-style
 * Accessibility access *revoked*: the equivalent `osascript`/System Events
 * per-window query failed there ("osascript is not allowed assistive
 * access", -1728/-25211) while this CoreGraphics path succeeded and
 * correctly found both `qemu-system-aarch64` windows. Never throws --
 * returns `null` on any failure so the caller falls through to the next
 * resolution step.
 * @param {string} processNamePattern
 * @returns {Promise<{x:number,y:number,w:number,h:number}|null>}
 */
async function autoDetectRegionViaCoreGraphics(processNamePattern) {
  const scriptPath = fileURLToPath(new URL('./photon-window-list.swift', import.meta.url));
  try {
    // Passing the script as a FILE ARGUMENT, not piped via stdin, is
    // deliberate: `execFile('swift', ['-'], {input: ...})` was tried first
    // during this ticket's own development and reproducibly HUNG
    // indefinitely (verified: a plain shell `echo '...' | swift -` pipe
    // completes in ~0.1s, but the equivalent Node `execFile` with an
    // `input` string never returned even after 15s, isolated down to
    // exactly this stdin-piping mechanism -- swift's non-TTY-stdin
    // handling doesn't play well with how Node's execFile writes+closes
    // the input pipe). A file argument is both faster and reliable
    // (~100ms observed) -- same file-argument precedent this module
    // already uses for src/frame-diff.mjs.
    const { stdout } = await execFileAsync('swift', [scriptPath, processNamePattern], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
    });
    /** @type {{x:number,y:number,w:number,h:number}|null} */
    let best = null;
    let bestArea = -1;
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(',').map((s) => Number(s.trim()));
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) continue;
      const [x, y, w, h] = parts;
      if (w <= 0 || h <= 0) continue;
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = { x, y, w, h };
      }
    }
    return best;
  } catch {
    return null; // Best-effort only.
  }
}

/**
 * Secondary best-effort auto-detection via `osascript`/System Events'
 * window position+size (the ticket's other named option). Kept as a
 * fallback attempt after `autoDetectRegionViaCoreGraphics` -- this path
 * genuinely fails on machines where the calling terminal/process lacks
 * Accessibility (System Events window-level) permission, a *different*
 * TCC gate than screen-recording permission, observed directly during
 * this ticket's own development (`osascript -e 'tell application "System
 * Events" to get windows of process "Finder"'` returned "System Events
 * got an error: osascript is not allowed assistive access. (-1728/-25211)"
 * even though the broader "get name of every process" form succeeded) --
 * so this function returns `null` on *any* failure rather than throwing,
 * and the caller falls through to the `--region` escape hatch per the
 * ticket's Risks section ("a manual --region x,y,w,h escape hatch is
 * acceptable for v1").
 * @param {string} processNamePattern
 * @returns {Promise<{x:number,y:number,w:number,h:number}|null>}
 */
async function autoDetectRegionViaOsascript(processNamePattern) {
  const script = `
tell application "System Events"
  set targetProc to missing value
  repeat with proc in (every process whose background only is false)
    if (name of proc as string) contains "${processNamePattern}" then
      set targetProc to proc
      exit repeat
    end if
  end repeat
  if targetProc is missing value then return "NOT_FOUND"
  set win to front window of targetProc
  set {winX, winY} to position of win
  set {winW, winH} to size of win
  return (winX as string) & "," & (winY as string) & "," & (winW as string) & "," & (winH as string)
end tell
`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { encoding: 'utf8' });
    const trimmed = stdout.trim();
    if (trimmed === 'NOT_FOUND' || trimmed.length === 0) return null;
    const parts = trimmed.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [x, y, w, h] = parts;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  } catch {
    return null; // Best-effort only -- e.g. Accessibility permission not granted.
  }
}

/**
 * Tries CoreGraphics first (works without Accessibility permission), then
 * falls back to osascript (works on machines where CoreGraphics's window
 * list is for some reason unavailable but Accessibility access has been
 * granted) -- covers both of the ticket's named options with the more
 * broadly-successful one tried first. Returns which method actually
 * succeeded alongside the region, so callers can report an accurate
 * `source` rather than assuming one path was used.
 * @param {string} processNamePattern
 * @returns {Promise<{region: {x:number,y:number,w:number,h:number}, method: string}|null>}
 */
async function autoDetectRegion(processNamePattern) {
  const viaCg = await autoDetectRegionViaCoreGraphics(processNamePattern);
  if (viaCg) return { region: viaCg, method: 'CoreGraphics window list auto-detect' };
  const viaOsascript = await autoDetectRegionViaOsascript(processNamePattern);
  if (viaOsascript) return { region: viaOsascript, method: 'osascript auto-detect' };
  return null;
}

/** Per-leg process-name pattern for auto-detection. */
const WINDOW_PROCESS_PATTERN = { b: 'qemu-system', c: 'Simulator' };

/**
 * Resolves the device-window region for a leg, in this priority order
 * (ticket: "located automatically if cheap ... or via a one-time
 * calibration step that saves the region to the run config" plus the
 * Risks section's "--region x,y,w,h escape hatch"):
 *   1. `--region` CLI flag (explicit, always wins -- also saved to the
 *      cache so the *next* run without an explicit flag reuses it).
 *   2. Cached calibration from a previous run (`photon-region.local.json`).
 *   3. Best-effort auto-detection: CoreGraphics window list first (no
 *      Accessibility permission needed), osascript/System Events second.
 * Throws (caller turns this into a named skip) only if none resolve.
 * @param {'b'|'c'} leg
 * @param {string|undefined} regionFlag
 * @returns {Promise<{region: {x:number,y:number,w:number,h:number}, source: string}>}
 */
export async function resolveRegion(leg, regionFlag) {
  if (regionFlag) {
    const region = parseRegionFlag(regionFlag);
    await saveRegionToCache(leg, region);
    return { region, source: '--region flag' };
  }

  const cache = await readRegionCache();
  if (cache?.[leg]) {
    return { region: cache[leg], source: 'cached calibration (photon-region.local.json)' };
  }

  const autoDetected = await autoDetectRegion(WINDOW_PROCESS_PATTERN[leg]);
  if (autoDetected) {
    await saveRegionToCache(leg, autoDetected.region);
    return { region: autoDetected.region, source: autoDetected.method };
  }

  throw new Error(
    `photon: could not resolve the device-window region for leg ${leg} -- auto-detection failed ` +
      '(commonly: Accessibility/Screen-Recording permission not yet granted to this terminal in ' +
      'System Settings > Privacy & Security). Run once with --region x,y,w,h (the device window\'s ' +
      'on-screen bounds in points) to calibrate; the region is then cached in photon-region.local.json ' +
      'for future runs.',
  );
}

// --- scene launch + single-tap driving --------------------------------------

/**
 * Launches `touch.latency` fresh (params include a very large `minSamples`
 * so the scene's own in-app finish logic never fires mid-run -- this
 * module, not the scene, decides when enough taps have been delivered) and
 * waits for its touch target to be visible.
 * @param {'b'|'c'} leg
 * @param {{ serial?: string, udid?: string }} deviceOpts
 */
async function launchTouchLatencySceneForPhoton(leg, deviceOpts) {
  // A minSamples far above anything this module will actually deliver --
  // the scene finishes (and writes its own results file/`bench-done`
  // testID) only once minSamples taps resolve, and this module's own tap
  // count is what actually gates how many taps get sent.
  const url = buildSceneUrl('touch.latency', { minSamples: 100_000 });

  if (leg === 'b') {
    const serial = /** @type {string} */ (deviceOpts.serial);
    await execFileAsync('adb', [
      '-s', serial, 'shell', 'rm', '-f',
      `/data/data/${ANDROID_APP_ID}/files/${RESULTS_FILENAME}`,
    ]).catch(() => {});
    await execFileAsync('adb', [
      '-s', serial, 'shell', 'am', 'start', '-W',
      '-a', 'android.intent.action.VIEW', '-d', url,
    ]);
  } else {
    const udid = /** @type {string} */ (deviceOpts.udid);
    try {
      const { stdout } = await execFileAsync('xcrun', ['simctl', 'get_app_container', udid, IOS_BUNDLE_ID, 'data']);
      await rm(path.join(stdout.trim(), 'Documents', RESULTS_FILENAME), { force: true });
    } catch {
      // App not installed yet, or no prior results file -- fine either way.
    }
    await execFileAsync('xcrun', ['simctl', 'openurl', udid, url]);
  }
}

/**
 * iOS-only YAML preamble that re-enters `touch.latency` inside the SAME
 * Maestro flow that performs the actual wait/tap step below it.
 *
 * Discovered during this ticket's own live verification (2026-09-02): a
 * bare Maestro flow with no `launchApp` step -- assuming the scene is
 * already showing from an earlier, separate `xcrun simctl openurl` call
 * -- reliably lost the app to the Home Screen between Maestro invocations
 * on the iOS simulator (confirmed via `simctl io ... screenshot`: the
 * Home Screen, not `touch.latency`, was on screen when this happened),
 * and a bare `launchApp` alone made it WORSE, not better -- it reliably
 * relaunched the app onto its default initial route (the debug scene-list
 * screen, confirmed the same way), never back to `touch.latency`. This is
 * the exact same failure mode T07's own `flows/touch-latency.yaml`
 * documents and fixes with a `launchApp` immediately followed by a
 * doubled `openLink` -- diagnosed there as "some one-time JS-bridge/URL-
 * listener readiness the first post-launchApp openLink races against."
 * T07's flow only pays this cost ONCE per Maestro invocation because all
 * 32 of its taps live inside that one flow's `repeat` block; this
 * module's per-tap design (see `runSingleTapFlow`'s own doc for why one
 * Maestro invocation per tap is required at all) means EVERY invocation
 * needs its own copy of this preamble, since each is a fresh Maestro
 * process with no memory of the last one's navigation state. Confirmed
 * live: a bare `tapOn` flow with no preamble hung for the flow's full
 * timeout (`timeout 124` in manual testing); the identical flow with this
 * preamble prepended completed in ~11s.
 *
 * Not needed on Android: leg b's `am start -W -a android.intent.action.VIEW
 * -d <url>` (in `launchTouchLatencySceneForPhoton`) reliably keeps the
 * Activity foregrounded across separate later Maestro invocations --
 * confirmed live in this same verification session (leg b's capture and
 * per-tap driving both completed normally without this preamble; only leg
 * c needed it).
 * @type {string}
 */
const IOS_REENTER_SCENE_PREAMBLE = [
  '- launchApp:',
  '    clearState: false',
  '- openLink: "emubench://scene/touch.latency?minSamples=100000"',
  '- openLink: "emubench://scene/touch.latency?minSamples=100000"',
].join('\n');

/**
 * Writes a Maestro flow file whose body is leg-appropriate: leg c gets
 * `IOS_REENTER_SCENE_PREAMBLE` prepended (see that constant's doc for why
 * every iOS invocation needs it); leg b's steps run as-is (Android's `am
 * start -W` keeps the Activity foregrounded across invocations, so no
 * per-invocation re-navigation is needed there).
 * @param {string} flowPath
 * @param {'b'|'c'} leg
 * @param {string[]} steps YAML lines for the flow's own step(s), e.g.
 *   `['- tapOn:', '    id: "touch-target"']`
 */
async function writeLegAwareFlow(flowPath, leg, steps) {
  const body =
    leg === 'c'
      ? [IOS_REENTER_SCENE_PREAMBLE, ...steps].join('\n')
      : steps.join('\n');
  await writeFile(flowPath, `appId: com.emubench.rig\n---\n${body}\n`, 'utf8');
}

/**
 * Runs a Maestro flow file against the given leg's device, throwing an
 * error whose message includes Maestro's own stderr (not just the bare
 * "Command failed: ..." exec summary `execFile`'s rejection carries by
 * default) -- discovered during this ticket's own verification that the
 * bare exec error swallowed the actual diagnosable detail (which
 * assertion failed, on which element) that made the launchApp/openLink
 * bug above findable at all.
 * @param {string} flowPath
 * @param {'b'|'c'} leg
 * @param {{ serial?: string, udid?: string }} deviceOpts
 * @param {number} timeoutMs
 */
async function runMaestroFlow(flowPath, leg, deviceOpts, timeoutMs) {
  const args =
    leg === 'b'
      ? ['--platform', 'android', '--udid', /** @type {string} */ (deviceOpts.serial), 'test', flowPath]
      : ['--platform', 'ios', '--udid', /** @type {string} */ (deviceOpts.udid), 'test', flowPath];
  try {
    await execFileAsync('maestro', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } catch (/** @type {any} */ err) {
    const detail = [err?.stdout, err?.stderr].filter(Boolean).join('\n').trim();
    throw new Error(
      `photon: maestro flow failed on leg ${leg} (${flowPath}): ${err?.message ?? err}` +
        (detail ? `\n${detail}` : ''),
    );
  }
}

/**
 * Waits (poll loop) for the scene's `touch-target` element to be visible,
 * via a tiny Maestro `assertVisible` flow -- reuses Maestro (already a
 * required dependency for this scene, T07) rather than adding a second
 * UI-inspection tool for a one-off wait.
 * @param {'b'|'c'} leg
 * @param {{ serial?: string, udid?: string }} deviceOpts
 */
async function waitForTouchTargetVisible(leg, deviceOpts) {
  const flowPath = path.join(flowsDir, 'photon-wait-visible.local.yaml');
  await writeLegAwareFlow(flowPath, leg, [
    '- extendedWaitUntil:',
    '    visible:',
    '      id: "touch-target"',
    '    timeout: 20000',
  ]);
  try {
    await runMaestroFlow(flowPath, leg, deviceOpts, SCENE_LAUNCH_TIMEOUT_MS);
  } finally {
    await rm(flowPath, { force: true }).catch(() => {});
  }
}

/**
 * Delivers exactly one tap to the scene's touch target via a single-tap
 * Maestro flow, returning the wall-clock instant (ms, `Date.now()`)
 * recorded immediately before invoking Maestro -- the driver-logged tap
 * timestamp the ticket requires. See file doc "Why this module drives
 * taps directly" for why one flow invocation per tap, rather than T07's
 * multi-tap `repeat` flow, is used here, and `IOS_REENTER_SCENE_PREAMBLE`'s
 * doc for why leg c's copy of this flow must re-enter the scene on every
 * single invocation.
 * @param {'b'|'c'} leg
 * @param {{ serial?: string, udid?: string }} deviceOpts
 * @returns {Promise<number>} `Date.now()` immediately before the tap was sent
 */
async function runSingleTapFlow(leg, deviceOpts) {
  const flowPath = path.join(flowsDir, 'photon-single-tap.local.yaml');
  await writeLegAwareFlow(flowPath, leg, ['- tapOn:', '    id: "touch-target"']);
  try {
    // Timestamp taken immediately before invoking Maestro, same as before
    // this leg-aware rewrite -- leg c's flow now does more work per
    // invocation (re-launch + re-navigate + tap, not just tap), but the
    // timestamp still marks "when this tap was requested," and the
    // analyzer's own tapFrameIndex-1 backward search (src/frame-diff.mjs)
    // already tolerates the resulting timing slack the same way it
    // tolerates ordinary per-tap Maestro overhead.
    const tapAtEpochMs = Date.now();
    await runMaestroFlow(flowPath, leg, deviceOpts, SINGLE_TAP_TIMEOUT_MS);
    return tapAtEpochMs;
  } finally {
    await rm(flowPath, { force: true }).catch(() => {});
  }
}

// --- screen recording -------------------------------------------------------

/**
 * Lists every avfoundation "Capture screen N" device by parsing
 * `ffmpeg -f avfoundation -list_devices true -i ""`'s stderr (ffmpeg
 * prints the device list to stderr and always exits non-zero for this
 * invocation -- expected, not an error condition). Returns pairs of
 * `{avDeviceIndex, screenNumber}` -- `avDeviceIndex` is the bracketed
 * number ffmpeg's `-i` flag actually wants (e.g. `[4] Capture screen 0`
 * means `-i 4:none`), `screenNumber` is the trailing "screen N" ffmpeg
 * itself labels each entry with, in `CGGetActiveDisplayList` order (see
 * `resolveCaptureDeviceForRegion`'s doc for why that ordering
 * matters). Neither number is fixed across machines (camera count varies
 * the avDeviceIndex; display count varies how many screen entries exist
 * at all), so this suite parses both at runtime rather than hardcoding
 * either.
 * @returns {Promise<Array<{avDeviceIndex: number, screenNumber: number}>>}
 */
async function listScreenCaptureDevices() {
  let stderr = '';
  try {
    await execFileAsync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
  } catch (/** @type {any} */ err) {
    stderr = err?.stderr ?? '';
  }
  /** @type {Array<{avDeviceIndex: number, screenNumber: number}>} */
  const devices = [];
  for (const match of stderr.matchAll(/\[(\d+)\]\s+Capture screen\s+(\d+)/gi)) {
    devices.push({ avDeviceIndex: Number(match[1]), screenNumber: Number(match[2]) });
  }
  if (devices.length === 0) {
    throw new Error(
      'photon: no avfoundation "Capture screen" device found. This usually means Screen Recording ' +
        'permission has not been granted to this terminal (System Settings > Privacy & Security > ' +
        'Screen Recording) -- ffmpeg only lists screen-capture devices once that permission is granted.',
    );
  }
  return devices;
}

/**
 * Resolves WHICH avfoundation "Capture screen N" device to record, given
 * the region a leg's target window actually sits in, AND translates that
 * region from macOS's global desktop coordinate space into the LOCAL
 * (top-left-origin, per-display) coordinate space that display's own
 * avfoundation capture stream uses -- fixes two real bugs found via this
 * ticket's own live verification, on consecutive fix/re-verify cycles:
 *
 * Bug 1 (device selection): this function previously didn't exist at
 * all, and its caller always recorded whichever screen device ffmpeg
 * listed first, regardless of which physical display the target window
 * was actually on. Correct on a single-display Mac (there is only one
 * screen to be wrong about) but silently wrong on a multi-display Mac
 * whenever the target window sits on a non-primary display -- confirmed
 * directly: on this development machine's two-display setup, a leg-c
 * capture using the always-first-device behavior recorded the built-in
 * display (`ffprobe`: 3024x1964, that display's own Retina-scaled
 * resolution) while the resolved region `(-2288,-410,399,919)` described
 * a window on the external ultrawide -- 0/32 taps ever matched because
 * the crop region and the recorded frame were different physical screens.
 * Fixed by having `src/photon-display-index.swift` report, for the given
 * region's center point, the index of the display containing it in
 * `CGGetActiveDisplayList`'s own enumeration order -- verified empirically
 * that avfoundation's "Capture screen N" label follows that SAME order
 * (capturing avfoundation device index 0 produced a frame at exactly the
 * built-in display's resolution, index 1 at exactly the external
 * display's).
 *
 * Bug 2 (coordinate space): fixing bug 1 alone still left 0/32 taps
 * resolved on the next run -- `region` is expressed in GLOBAL desktop
 * coordinates (can be negative on a display arranged left-of/above the
 * primary), but the crop this suite passes to `frame-diff.mjs` needs to
 * be in that specific display's own captured-frame coordinates. Fixed by
 * having `photon-display-index.swift` also report the matched display's
 * own `CGDisplayBounds` origin, so this function can translate:
 * `local = global - displayOrigin`. Verified empirically (not assumed)
 * that avfoundation's per-display capture frame uses the SAME top-left-
 * origin, Y-down convention as CGDisplayBounds for that display -- no
 * axis flip needed: a real probe frame, cropped at a KNOWN window's
 * global bounds minus its display's own origin, showed exactly that
 * window's own top-left corner (Chrome's title bar/favicon), not
 * something offset or upside-down.
 * @param {{x:number,y:number,w:number,h:number}} region global-coordinate-space region
 * @returns {Promise<{ avDeviceIndex: number, localRegion: {x:number,y:number,w:number,h:number} }>}
 */
async function resolveCaptureDeviceForRegion(region) {
  const devices = await listScreenCaptureDevices();
  if (devices.length === 1) {
    // Single-display machine (the common case): no ambiguity possible,
    // and the single display's origin is always (0,0) -- global and
    // local coordinates are identical, so skip invoking the Swift helper
    // at all.
    return { avDeviceIndex: devices[0].avDeviceIndex, localRegion: region };
  }

  const scriptPath = fileURLToPath(new URL('./photon-display-index.swift', import.meta.url));
  /** @type {{ targetScreenNumber: number, displayOriginX: number, displayOriginY: number }} */
  let resolved;
  try {
    const { stdout } = await execFileAsync(
      'swift',
      [scriptPath, String(region.x), String(region.y), String(region.w), String(region.h)],
      { encoding: 'utf8', timeout: 15_000 },
    );
    const parts = stdout.trim().split(',').map(Number);
    if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`unparseable output "${stdout.trim()}"`);
    }
    resolved = { targetScreenNumber: parts[0], displayOriginX: parts[1], displayOriginY: parts[2] };
  } catch (/** @type {any} */ err) {
    throw new Error(
      `photon: could not determine which display region ${JSON.stringify(region)} is on ` +
        `(${devices.length} screen-capture devices are available) -- photon-display-index.swift failed: ` +
        `${err?.message ?? err}`,
    );
  }

  const matched = devices.find((d) => d.screenNumber === resolved.targetScreenNumber);
  if (!matched) {
    throw new Error(
      `photon: display index ${resolved.targetScreenNumber} (from photon-display-index.swift) has no ` +
        `matching avfoundation "Capture screen ${resolved.targetScreenNumber}" device among ${JSON.stringify(devices)}`,
    );
  }
  return {
    avDeviceIndex: matched.avDeviceIndex,
    localRegion: {
      x: region.x - resolved.displayOriginX,
      y: region.y - resolved.displayOriginY,
      w: region.w,
      h: region.h,
    },
  };
}

/**
 * Starts an `ffmpeg -f avfoundation` full-screen recording at
 * `CAPTURE_FPS` to `outPath`, of whichever display `region` (the target
 * window's already-resolved, GLOBAL-coordinate-space bounds) sits on --
 * see `resolveCaptureDeviceForRegion`'s doc for why this is a display
 * lookup (not always "the first screen device") plus a coordinate-space
 * translation, not just the former. Full-DISPLAY (not pre-cropped to the
 * window) capture keeps the invocation simple; region cropping happens at
 * analysis time in decoded-pixel space (`src/frame-diff.mjs`), which also
 * means a mis-calibrated region can be re-analyzed from the same
 * recording without re-capturing -- but that later crop must be
 * expressed in the RECORDED DISPLAY's own local coordinates, hence
 * `localRegion` in this function's return value.
 * @param {string} outPath
 * @param {{x:number,y:number,w:number,h:number}} region GLOBAL-coordinate-space region (as resolveRegion returns)
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, startedAtEpochMs: number, localRegion: {x:number,y:number,w:number,h:number} }>}
 */
async function startScreenRecording(outPath, region) {
  const { avDeviceIndex: deviceIndex, localRegion } = await resolveCaptureDeviceForRegion(region);
  const proc = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'avfoundation',
      '-r', String(CAPTURE_FPS),
      '-i', `${deviceIndex}:none`,
      '-vcodec', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      outPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024); // bound memory on a long recording
  });
  // ffmpeg needs a moment to actually open the capture device before the
  // recording genuinely starts producing frame 0; without this delay, the
  // first tap(s) could be logged before any frames exist to search against.
  // `startedAtEpochMs` is deliberately read AFTER this delay, not before --
  // it is this module's estimate of "the wall-clock instant frame 0 was
  // captured," and every later `tapAtEpochMs - startedAtEpochMs` computation
  // depends on that estimate being as close to frame-0's true capture time
  // as cheaply possible (an offset error here would shift EVERY tap's
  // apparent frame index by the same constant, which the analyzer's
  // forward-only search from `tapFrameIndex - 1` cannot self-correct: too
  // large an offset causes missed detections by starting the search past
  // the true transition frame).
  await new Promise((r) => setTimeout(r, 1000));
  const startedAtEpochMs = Date.now();
  /** @type {any} */ (proc).__stderrRef = () => stderr;
  return { proc, startedAtEpochMs, localRegion };
}

/**
 * Stops an ffmpeg recording gracefully (`q` on stdin, matching ffmpeg's
 * own documented clean-shutdown control -- avoids a truncated/corrupt
 * trailing moov atom that SIGKILL or SIGTERM can leave behind), waiting
 * for the process to exit before returning.
 * @param {import('node:child_process').ChildProcess} proc
 * @returns {Promise<void>}
 */
function stopScreenRecording(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', () => resolve());
    proc.stdin?.write('q');
    proc.stdin?.end();
    // Fallback in case 'q' doesn't reach ffmpeg's input handler in time
    // (observed occasionally when stdin isn't a tty) -- SIGINT is still a
    // clean-shutdown signal for ffmpeg, just a less preferred one than 'q'.
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGINT');
    }, 3000);
  });
}

/**
 * Detects an all-(near-)black recording -- the ticket's Risks section:
 * "doctor should detect a black recording and print the System Settings
 * instruction" for the missing-screen-recording-permission case. Samples
 * a handful of frames across the recording (not just the first) via
 * ffmpeg's own `blackdetect` filter so a recording that's black only
 * because the capture started before anything was on screen doesn't
 * false-positive.
 * @param {string} videoPath
 * @returns {Promise<boolean>} true if the recording appears entirely black
 */
async function looksLikeBlackRecording(videoPath) {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      ['-i', videoPath, '-vf', 'blackdetect=d=0.5:pic_th=0.98', '-an', '-f', 'null', '-'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ).catch((/** @type {any} */ err) => ({ stderr: err?.stderr ?? '' }));
    const blackIntervals = [...stderr.matchAll(/black_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    if (blackIntervals.length === 0) return false;
    const totalBlackS = blackIntervals.reduce((a, b) => a + b, 0);
    const { stdout: durOut } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
    ]);
    const totalDurationS = Number(durOut.trim()) || 0;
    // A recording that's black for effectively its whole length (>=90%) is
    // almost certainly the missing-Screen-Recording-permission failure
    // mode, not a scene that legitimately spent most of its time on
    // COLOR_DARK (the scene alternates roughly 50/50, and taps are ~1s
    // apart -- nowhere near a 90% single-color duration).
    return totalDurationS > 0 && totalBlackS / totalDurationS >= 0.9;
  } catch {
    return false; // Best-effort diagnostic only -- never block the run on this check itself failing.
  }
}

// --- per-leg orchestration ---------------------------------------------------

/**
 * @param {'b'|'c'} leg
 * @param {{ region?: string, tapCount?: number }} opts
 * @returns {Promise<{samples: number[], method: string}>}
 */
async function runLeg(leg, opts) {
  if (!(await ffmpegAvailable())) {
    throw new Error('photon: ffmpeg not found on PATH (brew install ffmpeg) -- input-to-photon secondary requires it');
  }

  const tapCount = opts.tapCount ?? DEFAULT_TAP_COUNT;
  const { region, source: regionSource } = await resolveRegion(leg, opts.region);

  /** @type {{ serial?: string, udid?: string }} */
  const deviceOpts = {};
  if (leg === 'b') {
    const serial = (await firstAndroidDeviceSerial()) ?? EMULATOR_SERIAL;
    deviceOpts.serial = serial;
    await ensureAdbRoot({ serial });
  } else {
    deviceOpts.udid = (await firstBootedSimulatorUdid()) ?? 'booted';
  }

  await launchTouchLatencySceneForPhoton(leg, deviceOpts);
  await waitForTouchTargetVisible(leg, deviceOpts);

  await mkdir(scratchDir, { recursive: true });
  const videoPath = path.join(scratchDir, `photon-leg-${leg}.local.mov`);
  await rm(videoPath, { force: true }).catch(() => {});

  const { proc: recordingProc, startedAtEpochMs, localRegion } = await startScreenRecording(videoPath, region);

  /** @type {{tapIndex: number, tapAtMs: number}[]} */
  const taps = [];
  try {
    for (let i = 0; i < tapCount; i++) {
      const tapAtEpochMs = await runSingleTapFlow(leg, deviceOpts);
      taps.push({ tapIndex: i, tapAtMs: tapAtEpochMs - startedAtEpochMs });
      if (i < tapCount - 1) {
        await new Promise((r) => setTimeout(r, INTER_TAP_DELAY_MS));
      }
    }
  } finally {
    await stopScreenRecording(recordingProc);
  }

  if (await looksLikeBlackRecording(videoPath)) {
    throw new Error(
      `photon: leg ${leg} recording appears entirely black -- Screen Recording permission is likely ` +
        'not granted to this terminal. Grant it in System Settings > Privacy & Security > Screen ' +
        'Recording, then re-run.',
    );
  }

  const tapsPath = path.join(scratchDir, `photon-taps-leg-${leg}.local.json`);
  await writeFile(tapsPath, JSON.stringify(taps), 'utf8');

  const frameDiffPath = fileURLToPath(new URL('./frame-diff.mjs', import.meta.url));
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      frameDiffPath,
      '--video', videoPath,
      '--fps', String(CAPTURE_FPS),
      // localRegion, NOT the global-coordinate-space `region` resolveRegion
      // returned -- ffmpeg's crop filter here operates on the RECORDED
      // display's own captured frame, whose origin is that display's own
      // top-left corner, not the desktop's overall origin. See
      // resolveCaptureDeviceForRegion's doc for the bug this fixes and how
      // the translation was verified.
      '--region', `${localRegion.x},${localRegion.y},${localRegion.w},${localRegion.h}`,
      '--taps', tapsPath,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );

  /** @type {number[]} */
  const latencyMs = [];
  let nMissed = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed.event === 'tap_result' && typeof parsed.latencyMs === 'number') {
      latencyMs.push(parsed.latencyMs);
    } else if (parsed.event === 'tap_missed') {
      nMissed++;
    }
  }

  if (latencyMs.length === 0) {
    throw new Error(
      `photon: leg ${leg} frame-diff analyzer resolved 0/${tapCount} taps (global region ${JSON.stringify(region)} ` +
        `from ${regionSource}, translated to local region ${JSON.stringify(localRegion)} for the recorded display) ` +
        '-- the region likely doesn\'t cover the device window (or the window is occluded by another window in ' +
        'front of it -- this analyzer only sees whatever avfoundation actually captured, not window z-order); ' +
        'recalibrate with --region, or bring the target window to the front.',
    );
  }

  // Best-effort cleanup (ticket: "cleanup fully automated") -- the taps
  // JSON is scratch/local like every other rig-scenes.js pulled-results
  // file; the recording itself is bulky (60fps H.264 for the whole tap
  // sequence) and has no further use once analyzed.
  await rm(videoPath, { force: true }).catch(() => {});
  await rm(tapsPath, { force: true }).catch(() => {});

  if (nMissed > 0) {
    // eslint-disable-next-line no-console
    console.log(`emu-bench: photon.latency leg ${leg}: ${nMissed}/${tapCount} tap(s) missed (no detected pixel change), excluded from samples.`);
  }

  return { samples: latencyMs, method: METHOD, captureFps: CAPTURE_FPS };
}

/**
 * Registers `photon.latency` (results id, group 4, legs b/c). `run(ctx)`
 * reads `--region`/`--photon-taps` off `process.argv` directly (see note
 * below) rather than through `RunContext`, matching this suite's existing
 * precedent of CLI flags that only some entries care about not being
 * threaded through the shared `RunContext` type (src/commands/run.js's
 * `ctx` carries only `leg`/`config`/`exec`).
 *
 * Flags are read from `process.argv` (not a new RunContext field) because
 * `--region` is specific to this one benchmark id and CLI flag parsing
 * already lives in src/cli.js; run.js forwards its own flags object
 * through the process environment isn't needed since photon.js can parse
 * argv itself the same way src/cli.js does, without requiring every other
 * BenchmarkEntry's RunContext to grow a photon-specific field.
 */
export function registerPhotonBenchmarks() {
  register({
    id: 'photon.latency',
    group: 4,
    legs: ['b', 'c'],
    kind: 'micro',
    unit: 'ms',
    // GPU-heavy (PLAN.md §5/§4 Group 4: screen-recorded tap-to-pixel-change
    // -- every tap drives a real presented frame, recorded at 60fps for
    // n>=30 taps) -- T13 orchestrator inserts a cooldown after.
    gpuHeavy: true,
    async run(ctx) {
      if (ctx.leg !== 'b' && ctx.leg !== 'c') {
        throw new Error(`photon: leg "${ctx.leg}" not supported (no leg-A analog, SPEC.md §10)`);
      }
      const regionFlag = readCliFlag('--region');
      const tapCountFlag = readCliFlag('--photon-taps');
      return runLeg(ctx.leg, {
        region: regionFlag,
        tapCount: tapCountFlag ? Number(tapCountFlag) : undefined,
      });
    },
  });
}

/**
 * Reads a `--flag value` pair directly from `process.argv`, mirroring
 * src/cli.js's own parser but scoped to just this one benchmark's optional
 * flags so `run.js`'s shared flag object doesn't need a photon-specific
 * field threaded through every other registered benchmark.
 * @param {string} flag e.g. "--region"
 * @returns {string|undefined}
 */
function readCliFlag(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

export { CAPTURE_FPS, METHOD };
