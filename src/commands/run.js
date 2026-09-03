// @ts-check
/**
 * `emu-bench run` (SPEC.md §5, §1, §12; PLAN.md §5; ticket T13 scope). This
 * is the run **orchestrator**: it turns the registry into a disciplined
 * collection session rather than a bare "iterate every entry" loop. Earlier
 * tickets (T01 scaffold, T03/T05-T11 benchmark modules) built every
 * individual BenchmarkEntry and made each one correct in isolation; T13's
 * job is the policy layer on top — matrix construction (tuned-primary +
 * headline-subset-on-default, PLAN.md §5 "Config policy"), interleaved leg
 * scheduling within a group, per-benchmark n enforcement from registry
 * metadata, warmup discards, cooldowns after GPU-heavy scenes, CV flagging,
 * battery/thermal gates, retry-once-then-skip, resumability, a runtime
 * estimate, and the end-of-run session report — all as orchestrator code,
 * never as instructions a human must remember (SPEC.md §12).
 *
 * Device lifecycle: this module owns booting the config-appropriate AVD
 * (bench-tuned vs bench-default, SPEC.md §6) once per config pass, and the
 * iOS Simulator once per run — a real gap this ticket found and fixed
 * (src/scenarios/boot.js's `ensureEmulatorRunning`/`ensureSimulatorBooted`):
 * every individual BenchmarkEntry across kernels/rig-scenes/fence/photon/
 * scenarios assumes a device of the right kind is already up rather than
 * booting one itself, which is correct given each entry already re-resolves
 * its device serial idempotently on every call (T10/T11's own
 * resolveEmulatorSerial() precedent) — the orchestrator just has to make
 * that assumption true before iterating any leg-b/leg-c entry.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { requireAppleSilicon } from '../arm64-gate.js';
import {
  captureMachine,
  captureToolchain,
  captureGitSha,
  getPowerSource,
  getThermalPressure,
} from '../provenance.js';
import { benchmarksForGroups } from '../registry.js';
import { summarize, discardWarmups } from '../stats.js';
import { validateAgainstV1 } from '../schema.js';
import { resultsFilename } from '../results-writer.js';
import { ensureEmulatorRunning, ensureSimulatorBooted, shutdownAndroid } from '../scenarios/boot.js';
import {
  ANDROID_APP_ID as RIG_ANDROID_APP_ID,
  IOS_BUNDLE_ID as RIG_IOS_BUNDLE_ID,
  buildAndroidRelease,
  buildIosRelease,
  installAndroidApk,
  installIosApp,
  firstAndroidDeviceSerial,
  firstBootedSimulatorUdid,
} from '../rig-host.js';

// Registering built-in benchmarks as a side effect of importing them.
import '../benchmarks/demo.js';
import { registerKernelBenchmarks } from '../kernels.js';
registerKernelBenchmarks();
import { registerRigSceneBenchmarks } from '../rig-scenes.js';
registerRigSceneBenchmarks();
import { registerFenceBenchmarks } from '../fence.js';
registerFenceBenchmarks();
import { registerBootBenchmarks } from '../scenarios/boot.js';
registerBootBenchmarks();
import { registerInstallBenchmarks } from '../scenarios/install.js';
registerInstallBenchmarks();
import { registerTransferBenchmarks } from '../scenarios/transfer.js';
registerTransferBenchmarks();
import { registerRefreshBenchmarks } from '../scenarios/refresh.js';
registerRefreshBenchmarks();
import { registerTtiBenchmarks } from '../scenarios/tti.js';
registerTtiBenchmarks();
import { registerE2eBenchmarks } from '../scenarios/e2e.js';
registerE2eBenchmarks();
import { registerPhotonBenchmarks } from '../photon.js';
registerPhotonBenchmarks();

const WARMUP_DISCARDS = 2;

const rigDir = fileURLToPath(new URL('../../rig/', import.meta.url));

/** Groups whose entries route through rig-scenes.js's runRigScene (a deep
 * link into the already-installed rig app) rather than owning their own
 * install step: Group 2 (Hermes), Group 3 (Skia/list/nav), Group 4's
 * touch.latency, Group 5 (SQLite/IO). Group 6's own install.rig/
 * install.hello entries install (and uninstall/reinstall) the rig
 * themselves as part of what they measure, so they're deliberately
 * excluded here. */
const RIG_SCENE_GROUPS = [2, 3, 4, 5];

/** PLAN.md §5: "n>=10 macro / n>=30 micro" -- the orchestrator validates
 * (and annotates) every entry's actual sample count against this floor
 * rather than re-looping run(ctx) itself: every registered entry already
 * produces its own full n-sample set in one run(ctx) call (kernels.js's
 * `--samples`, boot.js's own internal N-iteration loops, fence.js's
 * FENCE_SAMPLES, etc. -- confirmed across every Group 1-6 module during
 * this ticket's implementation), so re-invoking run(ctx) N times would
 * multiply the sample count by N instead of enforcing a floor. */
const MIN_N = { micro: 30, macro: 10 };

/** PLAN.md §5: "flag CV > 10% as unstable." cv() (src/stats.js) returns a
 * ratio (stddev/mean), so the threshold is 0.10, not 10. */
const CV_FLAG_THRESHOLD = 0.1;

/** PLAN.md §5: "2-min cooldown after GPU-heavy scenes." */
const GPU_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * Headline subset (SPEC.md §5 `run`, PLAN.md §5 "Config policy"): "cold
 * boot, `list.scroll` p95, `sqlite.insert_fsync`, rig install" -- re-run on
 * leg B against the unmodified-defaults AVD so the tuned-vs-default delta
 * is its own finding. `install.rig` covers both registered variants
 * (install.rig.fresh, install.rig.upgrade -- src/scenarios/install.js) since
 * neither the ticket nor SPEC/PLAN distinguish fresh vs upgrade for this
 * policy; both count as "rig install."
 */
const HEADLINE_SUBSET_IDS = ['boot.cold', 'list.scroll', 'sqlite.insert_fsync', 'install.rig.fresh', 'install.rig.upgrade'];

/** Headline subset always runs on leg B only (SPEC.md §5: "re-run on the
 * default AVD" -- the default/tuned distinction is an Android emulator
 * config knob; SPEC.md §6 explicitly notes the simulator "has no
 * performance knobs to tune," so there is nothing to re-run on leg C). */
const HEADLINE_SUBSET_LEG = 'b';

/**
 * @param {{ groups?: string, legs?: string, config?: string, label?: string, endurance?: boolean, allowBattery?: boolean, flakeRuns?: string|number, resume?: string }} flags
 */
export async function runCommand(flags) {
  requireAppleSilicon();

  const groups = parseGroups(flags.groups);
  const legs = parseLegs(flags.legs);
  const label = flags.label ?? 'unlabeled';
  // SPEC.md §5 `run`: "Default behavior: full matrix on the tuned config,
  // then the headline subset ... re-run on the default config." Ticket
  // scope line 14: "`--config tuned|default|both` overrides" that default
  // -- so an omitted flag behaves like `both` (both passes), `tuned`/
  // `default` alone restrict to just that one pass over the requested
  // groups/legs (no headline narrowing for an explicit single-config
  // request -- the narrowing to the headline subset is specifically what
  // happens on the *second*, automatic pass of the default `both`-shaped
  // policy, not a general "default config" behavior).
  const configFlag = /** @type {'tuned'|'default'|'both'} */ (flags.config ?? 'both');
  const flakeRuns = flags.flakeRuns !== undefined ? Number(flags.flakeRuns) : undefined;

  // --- Power-source check (SPEC.md §5, §12; ticket line 15, 31) ---
  const { powerSource, onBattery } = await getPowerSource();
  let batteryOverrideUsed = false;
  if (onBattery) {
    if (!flags.allowBattery) {
      console.error(
        [
          'emu-bench: this Mac is running on battery power.',
          '',
          'Runs refuse to start on battery by default (PLAN.md §5 controls: AC',
          'power is a pinned condition — battery-throttled cores would bias',
          'every measurement). Plug in, or re-run with --allow-battery to',
          'proceed anyway (the override is recorded in the results file).',
        ].join('\n'),
      );
      process.exit(1);
    }
    batteryOverrideUsed = true;
    console.error(
      'emu-bench: WARNING — running on battery power with --allow-battery. Recorded in results.',
    );
  }

  // --- Provenance (SPEC.md §7, §12) ---
  const [machine, toolchain, suiteGitSha] = await Promise.all([
    captureMachine(),
    captureToolchain(),
    captureGitSha(),
  ]);
  // machine.powerSource from captureMachine() and the check above both read
  // pmset independently; keep them consistent by trusting the check we just
  // gated on (avoids a race between the two calls reporting differently).
  machine.powerSource = powerSource;
  // SPEC.md §12: "Thermal pressure sampled at start and between groups;
  // runs annotated." Start-of-run sample already lives in
  // machine.thermalPressureStart (captureMachine()); this run's own
  // between-groups samples are collected below into `thermalLog`.
  /** @type {{ at: string, group: number|null, pressure: string }[]} */
  const thermalLog = [{ at: new Date().toISOString(), group: null, pressure: machine.thermalPressureStart }];

  // --- Resume (ticket scope: "--resume <file> continues an interrupted
  // session ... completed benchmark ids are skipped on resume") ---
  /** @type {import('../types.js').BenchmarkResult[]} */
  let benchmarks = [];
  /** @type {import('../types.js').Skip[]} */
  let skipped = [];
  /** @type {Set<string>} keyed id\x1fleg\x1fconfig -- distinguishes a
   *  headline-subset id's default-config rerun from its tuned-pass run of
   *  the same id/leg. */
  const completed = new Set();
  let resumedFrom = /** @type {string|null} */ (null);
  // Carried-in skip count for removeOneStaleSkip (real T13 bug found on
  // reviewer re-check: without this, "drop the stale skip before
  // re-attempting a cell" could remove a skip *this same process* just
  // recorded, not only genuine resume-file carryover -- see
  // removeOneStaleSkip's own comment). 0 on a fresh run, since `skipped`
  // starts empty and everything pushed onto it from here on is a live
  // same-run skip, never carryover. Snapshotted here, once, before this
  // run pushes anything of its own -- `skipped.length` at this exact
  // point *is* the carried-in prefix.
  const carriedSkips = { count: 0 };
  if (flags.resume) {
    const prior = JSON.parse(await readFile(String(flags.resume), 'utf8'));
    benchmarks = Array.isArray(prior.benchmarks) ? prior.benchmarks : [];
    skipped = Array.isArray(prior.skipped) ? prior.skipped : [];
    carriedSkips.count = skipped.length;
    for (const b of benchmarks) completed.add(completedKey(b.id, b.leg, b.config));
    resumedFrom = String(flags.resume);
    console.log(
      `emu-bench: resuming from ${resumedFrom} (${benchmarks.length} benchmark(s) already recorded, will be skipped)`,
    );
  }

  // --- Build the matrix: one or two config passes, each a list of
  // {group, entries} in group order (SPEC.md §5 `run`; PLAN.md §5) ---
  const passes = buildPasses({ groups, legs, configFlag });

  // --- Runtime estimate (ticket scope: "printed up front ... so a runner
  // knows what they're committing to") ---
  printRuntimeEstimate(passes);

  // --- Checkpoint target (real T13 bug found on reviewer re-check: the
  // results object was previously assembled/validated/written exactly
  // once, after every pass finished -- a run killed mid-way left no file
  // at all, so acceptance criterion 3's own premise ("device crashed
  // mid-run") could never actually be exercised, only simulated by
  // resuming from an already-complete file). The path is resolved once,
  // up front, and every checkpoint (including the final one) writes back
  // to this same path -- a fresh run reserves the dated filename src/
  // results-writer.js's resultsFilename() computes (chip-slug/date/label),
  // and every checkpoint in that same process (and a --resume's
  // checkpoints) overwrite it in place, so there is always exactly one
  // file for this session, complete or partial. Passed into runPass so
  // it can checkpoint after every
  // group boundary -- a partial benchmarks/skipped array already
  // validates against schema/v1.json (nothing in the schema requires
  // "every registered benchmark present," SPEC.md §7's benchmarks[] items
  // are independently well-formed).
  const resultsPath = resumedFrom ?? (await reserveResultsPath({ chip: machine.chip, label }));

  /** @type {() => Promise<void>} */
  const checkpoint = async () => {
    const resultsObject = assembleResultsObject({
      label,
      suiteGitSha,
      machine,
      toolchain,
      benchmarks,
      skipped,
      batteryOverrideUsed,
      thermalLog,
      resumedFrom,
    });
    const { valid, errors } = await validateAgainstV1(resultsObject);
    if (!valid) {
      console.error('emu-bench: internal error — results object failed schema validation:');
      for (const e of errors) console.error(`  ${e}`);
      process.exit(1);
    }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(resultsPath, JSON.stringify(resultsObject, null, 2) + '\n', 'utf8');
  };

  for (const pass of passes) {
    await runPass({
      pass,
      flakeRuns,
      completed,
      benchmarks,
      skipped,
      carriedSkips,
      thermalLog,
      checkpoint,
    });
  }

  // Final checkpoint (identical mechanics to every mid-run one above --
  // kept as an explicit last write, not just "whatever the last group's
  // checkpoint left," so the file's `run.timestamp` and `notes` reflect
  // the run's actual completion rather than its last group boundary).
  await checkpoint();

  printSessionReport({ benchmarks, skipped, writtenPath: resultsPath });

  // End-of-run device shutdown (real T13 bug found during this ticket's
  // own rehearsal run: a run that boots the emulator itself -- as this
  // orchestrator does per pass -- left it running after the last pass
  // finished, and because bootAndroidOnce spawns it with piped stdio
  // (needed to watch for quickboot-fallback log text), that live child
  // process keeps this orchestrator's own event loop alive indefinitely
  // even after every result is written and the session report printed --
  // "completes unattended" (ticket acceptance criterion 1) means the
  // process actually exits, not just that its last useful line of
  // output was printed). Graceful (`adb emu kill`, same path
  // boot.cold/boot.warm use between their own iterations), so any
  // quickboot snapshot state gets a normal save-on-exit rather than
  // being abandoned. Best-effort: if nothing is running (e.g. a
  // leg-a/leg-c-only run that never touched the emulator, or a --resume
  // that skipped every leg-b entry), this is a fast no-op via
  // shutdownAndroid's own "already gone" handling.
  await shutdownAndroid();
}

/**
 * @param {string} id
 * @param {string} leg
 * @param {string|null|undefined} config
 * @returns {string}
 */
function completedKey(id, leg, config) {
  return `${id}\x1f${leg}\x1f${config ?? ''}`;
}

/**
 * Removes (in place) the first `skipped[]` entry matching `id`+`leg`, if
 * any -- FIFO per id+leg, not "every match" (see the call site's own
 * comment for why: schema/v1.json's skip rows carry no `config`, so this
 * is the only way to avoid conflating two independent skips that share
 * an id+leg under different configs, e.g. the headline subset's
 * boot.cold leg b attempted on both tuned and default).
 *
 * Eligibility is restricted to the *carried-in* prefix of `skipped`
 * (real T13 bug found on reviewer re-check: this was previously called
 * unconditionally before every attempt, searching the *entire* shared
 * array -- on a fresh, non-resumed run, or on the second config pass of
 * a resumed one, that array already contains skips *this same process*
 * pushed for other cells earlier in the run, e.g. the tuned pass's own
 * `skipped.push(...)` for a headline-subset id/leg that later fails
 * again on the default pass's attempt of the *same* id/leg -- so a
 * legitimate same-run skip got spliced out as if it were resume-stale,
 * silently vanishing a matrix cell or conflating two independent
 * failures into one). `carried` tracks how many entries at the *front*
 * of `skipped` are still unconsumed resume-file carryover -- 0 on a
 * fresh run, so this is unconditionally a no-op there, matching what
 * the call site always intended. New skips this process records are
 * always appended via `skipped.push` (never spliced into the front), so
 * "first `carried.count` entries" remains exactly the carried set for
 * the whole run regardless of how many have already been consumed here
 * -- removing one decrements `carried.count` by one, keeping the
 * invariant intact rather than needing an index boundary.
 * @param {import('../types.js').Skip[]} skipped mutated in place
 * @param {{ count: number }} carried mutated in place -- remaining carried-skip count
 * @param {string} id
 * @param {string} leg
 * @returns {void}
 */
function removeOneStaleSkip(skipped, carried, id, leg) {
  if (carried.count <= 0) return;
  const idx = skipped.slice(0, carried.count).findIndex((s) => s.id === id && s.leg === leg);
  if (idx !== -1) {
    skipped.splice(idx, 1);
    carried.count -= 1;
  }
}

/**
 * Resolves (and creates the parent directory for, but does not write to)
 * the results file path a fresh run's checkpoints will write to
 * throughout the whole run -- the same chip-slug/date/label filename
 * convention src/results-writer.js's writeResults() mints, computed once
 * up front rather than once per checkpoint so every checkpoint in this
 * process targets the identical path.
 * @param {{ chip: string, label: string }} args
 * @returns {Promise<string>} absolute path (not yet written)
 */
async function reserveResultsPath({ chip, label }) {
  const { mkdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const resultsDir = fileURLToPath(new URL('../../results/', import.meta.url));
  await mkdir(resultsDir, { recursive: true });
  const filename = resultsFilename({ chip, date: new Date(), label });
  return path.join(resultsDir, filename);
}

/**
 * Assembles the schema-shaped results object from current run state.
 * Pure (no I/O) -- called by every checkpoint (mid-run and final) so
 * every write goes through the identical shape/validation path (SPEC.md
 * §7).
 * @param {{ label: string, suiteGitSha: string, machine: import('../types.js').Machine, toolchain: import('../types.js').Toolchain, benchmarks: import('../types.js').BenchmarkResult[], skipped: import('../types.js').Skip[], batteryOverrideUsed: boolean, thermalLog: {at: string, group: number|null, pressure: string}[], resumedFrom: string|null }} args
 * @returns {object}
 */
function assembleResultsObject({
  label,
  suiteGitSha,
  machine,
  toolchain,
  benchmarks,
  skipped,
  batteryOverrideUsed,
  thermalLog,
  resumedFrom,
}) {
  return {
    schemaVersion: 1,
    run: {
      timestamp: new Date().toISOString(),
      label,
      suiteGitSha,
    },
    machine,
    toolchain,
    config: { avdTuned: {}, avdDefault: {} },
    benchmarks,
    skipped,
    notes: [
      batteryOverrideUsed ? 'Ran on battery power via --allow-battery override.' : '',
      `Thermal pressure log: ${JSON.stringify(thermalLog)}`,
      resumedFrom ? `Resumed from ${resumedFrom}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/**
 * @typedef {Object} Pass
 * @property {'tuned'|'default'} config
 * @property {string[]} legs the legs this pass actually executes (already
 *   intersected with the CLI's `--legs` request; the headline-subset pass
 *   is always exactly `['b']` regardless of `--legs`, SPEC.md §6).
 * @property {Map<number, import('../types.js').BenchmarkEntry[]>} byGroup
 *   entries for this pass, grouped by `group`, in ascending group order.
 */

/**
 * Constructs the pass list (SPEC.md §5 `run`; PLAN.md §5 "Config policy").
 * @param {{ groups: number[], legs: string[], configFlag: 'tuned'|'default'|'both' }} args
 * @returns {Pass[]}
 */
function buildPasses({ groups, legs, configFlag }) {
  /** @type {Pass[]} */
  const passes = [];

  if (configFlag === 'tuned' || configFlag === 'both') {
    passes.push(buildPass({ groups, legs, config: 'tuned', restrictToIds: null }));
  }
  if (configFlag === 'default') {
    // Explicit `--config default` alone: run the *requested* groups/legs
    // entirely on the default AVD -- no headline narrowing (that
    // narrowing is specifically the second half of the default `both`
    // policy, not a general property of "default config").
    passes.push(buildPass({ groups, legs, config: 'default', restrictToIds: null }));
  }
  if (configFlag === 'both') {
    // The automatic second pass: headline subset only, leg B only,
    // regardless of what --legs requested (SPEC.md §6: no tuned/default
    // knob exists for leg C, so there is nothing to re-run there).
    passes.push(
      buildPass({
        groups,
        legs: [HEADLINE_SUBSET_LEG],
        config: 'default',
        restrictToIds: HEADLINE_SUBSET_IDS,
      }),
    );
  }

  return passes;
}

/**
 * @param {{ groups: number[], legs: string[], config: 'tuned'|'default', restrictToIds: string[]|null }} args
 * @returns {Pass}
 */
function buildPass({ groups, legs, config, restrictToIds }) {
  let entries = benchmarksForGroups(groups).filter((e) => e.legs.some((l) => legs.includes(l)));
  if (restrictToIds) {
    entries = entries.filter((e) => restrictToIds.includes(e.id));
  }
  /** @type {Map<number, import('../types.js').BenchmarkEntry[]>} */
  const byGroup = new Map();
  for (const entry of entries) {
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }
  // Ascending group order, matching the registry's own group numbering
  // (SPEC.md §4 groups 1-7).
  const sortedByGroup = new Map([...byGroup.entries()].sort((a, b) => a[0] - b[0]));
  return { config, legs, byGroup: sortedByGroup };
}

/**
 * Sum of every entry's durationEstimateS across every pass (ticket scope:
 * "Runtime estimate printed up front ... sum of registered durations").
 * Entries without an explicit estimate fall back to a coarse per-kind
 * default so the total is still a real (if rough) number rather than
 * silently excluding un-annotated entries.
 * @param {Pass[]} passes
 */
function printRuntimeEstimate(passes) {
  const FALLBACK_S = { micro: 30, macro: 120 };
  let totalS = 0;
  let count = 0;
  for (const pass of passes) {
    for (const [, entries] of pass.byGroup) {
      for (const entry of entries) {
        const legCount = entry.legs.filter((l) => pass.legs.includes(l)).length;
        const perLeg = entry.durationEstimateS ?? FALLBACK_S[entry.kind];
        totalS += perLeg * legCount;
        count += legCount;
      }
    }
  }
  const minutes = Math.round(totalS / 60);
  console.log(
    `emu-bench: runtime estimate — ${count} benchmark/leg invocation(s) across ${passes.length} pass(es), roughly ${minutes} minute(s) (sum of registered/fallback per-entry durations; actual time varies with device speed and retries).`,
  );
}

/**
 * Executes one full pass: ensures the pass's device(s) are up, then
 * iterates groups in order, interleaving leg order within each group
 * (ticket scope: "execute registry benchmarks in interleaved leg order
 * (A,B,C,A,B,C…) within each group"), enforcing n, discarding warmups,
 * inserting cooldowns after GPU-heavy entries, retrying a failed
 * benchmark once before recording a skip, sampling thermal pressure
 * between groups, and checkpointing the results file to disk at each
 * group boundary (real T13 bug found on reviewer re-check: without this,
 * a run killed mid-way left no file at all, so --resume's own "device
 * crashed mid-run" scenario could never actually be exercised).
 * @param {{ pass: Pass, flakeRuns: number|undefined, completed: Set<string>, benchmarks: import('../types.js').BenchmarkResult[], skipped: import('../types.js').Skip[], carriedSkips: { count: number }, thermalLog: {at: string, group: number|null, pressure: string}[], checkpoint: () => Promise<void> }} args
 */
async function runPass({ pass, flakeRuns, completed, benchmarks, skipped, carriedSkips, thermalLog, checkpoint }) {
  const needsEmulator = pass.legs.includes('b');
  const needsSimulator = pass.legs.includes('c');

  console.log(`emu-bench: starting pass — config=${pass.config} legs=${pass.legs.join(',')}`);

  // Device lifecycle (SPEC.md §1 "boot/shutdown devices per leg as
  // needed"; ticket scope): boot the config-appropriate AVD / the
  // simulator once per pass, up front -- every individual BenchmarkEntry
  // already assumes its device is up (see this module's header comment).
  if (needsEmulator) {
    await ensureEmulatorRunning(pass.config);
  }
  if (needsSimulator) {
    await ensureSimulatorBooted();
  }

  // Rig app install (real T13 integration bug found during this ticket's
  // own rehearsal run): rig-scenes.js's entries deep-link into the rig
  // app via `am start`/`simctl openurl` and never install it themselves
  // -- they assume it's already there, which held throughout the tuned
  // pass only because the app happened to already be installed on the
  // devices this suite had used before. A freshly-booted device this
  // orchestrator boots itself (bench-default, booted here for the first
  // time in the run's headline-subset pass) starts with nothing
  // installed, so list.scroll/sqlite.insert_fsync failed outright until
  // this step was added. Installed once per pass, only when this pass
  // actually has a rig-scene-group entry to run, and skipped entirely if
  // the app is already present (checked directly rather than
  // unconditionally reinstalling every pass).
  const hasRigSceneEntries = [...pass.byGroup.keys()].some((g) => RIG_SCENE_GROUPS.includes(g));
  if (hasRigSceneEntries) {
    if (needsEmulator) {
      await ensureRigAppInstalledAndroid();
    }
    if (needsSimulator) {
      await ensureRigAppInstalledIos();
    }
  }

  for (const [group, entries] of pass.byGroup) {
    console.log(`emu-bench: group ${group} — ${entries.length} benchmark(s)`);

    // Interleaved leg order within the group (A,B,C,A,B,C… across the
    // group's distinct benchmark ids): each entry's own run(ctx) already
    // returns that leg's *entire* n-sample set in one call (kernels.js
    // --samples, boot.js's internal N-iteration loops, etc. -- every
    // Group 1-6 module confirmed during this ticket), so the finest
    // interleaving granularity available without rewriting every entry's
    // API is per-entry: for each id in the group, run leg A then B then
    // C (only the legs both this pass and the entry support), and move
    // to the next id -- producing exactly the alternating leg sequence
    // "A,B,C,A,B,C…" the ticket's acceptance criterion checks for in the
    // log.
    for (const entry of entries) {
      const entryLegs = /** @type {const} */ (['a', 'b', 'c']).filter(
        (l) => entry.legs.includes(l) && pass.legs.includes(l),
      );
      for (const leg of entryLegs) {
        const key = completedKey(entry.id, leg, pass.config);
        if (completed.has(key)) {
          console.log(`emu-bench: [resume] skipping already-completed ${entry.id} leg ${leg} config ${pass.config}`);
          continue;
        }

        console.log(`emu-bench: running ${entry.id} — leg ${leg}, config ${pass.config}`);

        // Drop one stale skipped[] entry for this cell before
        // re-attempting it (real T13 bug found on reviewer re-check:
        // resume carries prior skips over verbatim while re-attempting
        // those same cells -- skips are deliberately excluded from
        // `completed` above -- so a re-attempt that fails again appended
        // a *duplicate* skip, and one that succeeded left a *stale* skip
        // sitting alongside the new benchmark row it contradicted).
        // FIFO-consumes at most one matching `id`+`leg` entry rather than
        // removing every match: schema/v1.json's skipped[] items have no
        // `config` field (id/leg/reason only, additionalProperties:
        // false), so a headline-subset id/leg attempted under *both*
        // tuned and default (boot.cold/list.scroll/sqlite.insert_fsync/
        // install.rig.* on leg b) can legitimately carry two independent
        // skip rows sharing the same id+leg -- blindly removing every
        // match on the first (tuned) attempt would also delete the
        // second (default) attempt's not-yet-stale skip before it was
        // even re-examined. Passes run in a fixed order (tuned before
        // the default headline pass, buildPasses' own push order), so
        // consuming oldest-loaded-first here lines up each config's
        // re-attempt with the skip it actually made stale.
        //
        // Restricted to the carried-in prefix via `carriedSkips` (real
        // T13 bug found on reviewer re-check: this was previously called
        // unconditionally with no such restriction, so it searched the
        // *entire* shared `skipped` array -- including skips *this same
        // process* had already pushed for other cells, e.g. the tuned
        // pass's own skip of a headline-subset id/leg, still sitting in
        // the array when the default pass later attempts that identical
        // id/leg. A same-run skip is never resume-stale -- it's this
        // run's own just-recorded outcome -- so erasing it either
        // silently drops a matrix cell (if the later attempt then
        // succeeds, the earlier failure lands in neither benchmarks[]
        // nor skipped[]) or conflates two independent failures into one
        // (if it fails again too). `carriedSkips.count` is 0 on a fresh,
        // non-resumed run (see runCommand), so this call is
        // unconditionally a no-op there -- exactly what "fresh run"
        // should mean, now enforced rather than incidental.
        removeOneStaleSkip(skipped, carriedSkips, entry.id, leg);

        const outcome = await runOneWithRetry({ entry, leg, config: pass.config, flakeRuns });
        if (outcome.ok) {
          const { kept, discarded } = discardWarmups(outcome.rawSamples, WARMUP_DISCARDS);
          const summary = summarize(kept, discarded);
          const minN = MIN_N[entry.kind];
          if (summary.n < minN) {
            console.log(
              `emu-bench: WARNING — ${entry.id} leg ${leg}: n=${summary.n} is below the ${entry.kind} floor of ${minN} (PLAN.md §5). Recorded as-is, not skipped -- a below-floor n is itself provenance a runner needs to see, not a reason to discard real data.`,
            );
          }
          const cvFlagged = summary.cv > CV_FLAG_THRESHOLD;
          if (cvFlagged) {
            console.log(
              `emu-bench: ${entry.id} leg ${leg}: CV ${(summary.cv * 100).toFixed(1)}% exceeds the 10% flag threshold (PLAN.md §5) — flagged as unstable in the results file.`,
            );
          }
          benchmarks.push({
            group: entry.group,
            id: entry.id,
            leg,
            config: pass.config,
            unit: entry.unit,
            ...(outcome.method !== undefined ? { method: outcome.method } : {}),
            ...(outcome.captureFps !== undefined ? { captureFps: outcome.captureFps } : {}),
            ...summary,
            ...(cvFlagged ? { cvFlagged: true } : {}),
          });
          completed.add(key);
        } else {
          skipped.push({ id: entry.id, leg, reason: outcome.reason });
          console.log(`emu-bench: SKIPPED ${entry.id} leg ${leg} — ${outcome.reason}`);
        }

        // Checkpoint (real T13 bug found on reviewer re-check: the
        // results object was previously assembled/validated/written
        // exactly once, after every pass finished, so a run killed
        // mid-way left no file at all). Written after *every* benchmark
        // cell's outcome, not just at group boundaries -- a single group
        // can itself run for many minutes (Group 1's 8 kernels x 3 legs,
        // Group 6's boot/install/e2e sequence), during which a
        // group-boundary-only checkpoint would still leave the whole
        // group's progress unprotected; confirmed directly during this
        // fix's own verification, where killing a `--groups 1` run
        // partway through with only a group-boundary checkpoint produced
        // no file at all even though several kernels had already
        // finished. The write itself is cheap (one JSON.stringify plus
        // one file write of already-in-memory data), so doing it once
        // per benchmark rather than once per group costs nothing
        // meaningful against benchmarks that themselves take tens of
        // seconds to minutes.
        await checkpoint();

        // Cooldown after GPU-heavy scenes (PLAN.md §5; SPEC.md §12) --
        // inserted after every attempt (success or skip alike: the
        // thermal load a GPU-heavy scene put on the host doesn't
        // un-happen just because the benchmark ultimately failed), and
        // after this cell's own checkpoint so a kill during the
        // cooldown sleep still leaves the just-finished benchmark
        // persisted.
        if (entry.gpuHeavy) {
          console.log(`emu-bench: cooldown (${GPU_COOLDOWN_MS / 1000}s) after GPU-heavy scene ${entry.id}`);
          await sleep(GPU_COOLDOWN_MS);
        }
      }
    }

    // Thermal pressure sampled between groups (SPEC.md §12). The
    // per-benchmark checkpoint above already covers this group's
    // benchmarks/skipped; this update reaches the file on the *next*
    // checkpoint (the first benchmark of the next group, or the run's
    // final checkpoint if this was the last group) rather than needing
    // its own write here.
    const pressure = await getThermalPressure();
    thermalLog.push({ at: new Date().toISOString(), group, pressure });
    console.log(`emu-bench: thermal pressure after group ${group}: ${pressure}`);
  }
}

/**
 * Installs the rig app on the current Android device if it isn't already
 * there (checked via `pm list packages`, not unconditionally reinstalled).
 * @returns {Promise<void>}
 */
async function ensureRigAppInstalledAndroid() {
  const serial = await firstAndroidDeviceSerial();
  if (!serial) {
    throw new Error('run: no Android device found when trying to ensure the rig app is installed');
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('adb', ['-s', serial, 'shell', 'pm', 'list', 'packages', RIG_ANDROID_APP_ID]);
  if (stdout.includes(RIG_ANDROID_APP_ID)) return;
  console.log('emu-bench: rig app not yet installed on this device — building + installing before rig-scene entries run');
  const apkPath = await buildAndroidRelease({ rigDir });
  await installAndroidApk(apkPath, { serial });
}

/**
 * Installs the rig app on the booted iOS Simulator if it isn't already
 * there (checked via `simctl get_app_container`, which fails when the
 * bundle isn't installed).
 * @returns {Promise<void>}
 */
async function ensureRigAppInstalledIos() {
  const udid = (await firstBootedSimulatorUdid()) ?? 'booted';
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('xcrun', ['simctl', 'get_app_container', udid, RIG_IOS_BUNDLE_ID, 'data']);
    return; // already installed
  } catch {
    // Not installed -- fall through to build + install.
  }
  console.log('emu-bench: rig app not yet installed on this simulator — building + installing before rig-scene entries run');
  const appPath = await buildIosRelease({ rigDir, udid });
  await installIosApp(appPath, { udid });
}

/**
 * Runs one benchmark entry once; on failure, retries exactly once before
 * giving up (ticket scope: "failed benchmark after one retry ... land in
 * skipped[]").
 * @param {{ entry: import('../types.js').BenchmarkEntry, leg: string, config: 'tuned'|'default', flakeRuns: number|undefined }} args
 * @returns {Promise<{ ok: true, rawSamples: number[], method?: string, captureFps?: number } | { ok: false, reason: string }>}
 */
async function runOneWithRetry({ entry, leg, config, flakeRuns }) {
  /** @type {unknown} */
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      /** @type {import('../types.js').RunContext} */
      const ctx = {
        leg: /** @type {'a'|'b'|'c'} */ (leg),
        config,
        ...(flakeRuns !== undefined ? { flakeRuns } : {}),
        exec: async (cmd, args) => {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const run = promisify(execFile);
          return run(cmd, args, { encoding: 'utf8' });
        },
      };
      const ran = await entry.run(ctx);
      const rawSamples = Array.isArray(ran) ? ran : ran.samples;
      const method = Array.isArray(ran) ? undefined : ran.method;
      const captureFps = Array.isArray(ran) ? undefined : ran.captureFps;
      return { ok: true, rawSamples, method, captureFps };
    } catch (/** @type {any} */ err) {
      lastErr = err;
      if (attempt === 1) {
        console.log(`emu-bench: ${entry.id} leg ${leg} failed (attempt 1/2), retrying once — ${err?.message ?? err}`);
      }
    }
  }
  const reason = /** @type {any} */ (lastErr)?.message ?? String(lastErr);
  return { ok: false, reason: `failed after 1 retry: ${reason}` };
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * End-of-run console summary (ticket scope: "per-group medians, flagged
 * CVs, skips").
 * @param {{ benchmarks: import('../types.js').BenchmarkResult[], skipped: import('../types.js').Skip[], writtenPath: string }} args
 */
function printSessionReport({ benchmarks, skipped, writtenPath }) {
  console.log('\nemu-bench: session report');
  console.log('=========================');
  /** @type {Map<number, import('../types.js').BenchmarkResult[]>} */
  const byGroup = new Map();
  for (const b of benchmarks) {
    const list = byGroup.get(b.group) ?? [];
    list.push(b);
    byGroup.set(b.group, list);
  }
  for (const [group, list] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`\nGroup ${group}:`);
    for (const b of list) {
      const flag = b.cvFlagged ? '  [CV FLAGGED]' : '';
      console.log(`  ${b.id} (leg ${b.leg}, ${b.config}): median=${b.median} ${b.unit}, n=${b.n}${flag}`);
    }
  }
  const cvFlaggedCount = benchmarks.filter((b) => b.cvFlagged).length;
  console.log(`\nCV-flagged: ${cvFlaggedCount} of ${benchmarks.length} benchmark row(s)`);
  console.log(`Skips: ${skipped.length}`);
  for (const s of skipped) {
    console.log(`  ${s.id} (leg ${s.leg}): ${s.reason}`);
  }
  console.log(`\nemu-bench: wrote ${writtenPath}`);
}

/**
 * @param {string|undefined} raw e.g. "1,2,5" or "1-3"
 * @returns {number[]}
 */
function parseGroups(raw) {
  if (!raw) return [1, 2, 3, 4, 5, 6, 7];
  const parts = raw.split(',').flatMap((part) => {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    return [Number(part)];
  });
  return parts.filter((n) => Number.isInteger(n));
}

/**
 * @param {string|undefined} raw e.g. "a,b,c"
 * @returns {string[]}
 */
function parseLegs(raw) {
  if (!raw) return ['a', 'b', 'c'];
  return raw.split(',').map((s) => s.trim().toLowerCase());
}
