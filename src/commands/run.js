// @ts-check
/**
 * `emu-bench run` (SPEC.md §5, §1). T01 scope: execute whatever is in the
 * registry for the requested groups on leg A, with full provenance, and
 * write a schema-valid results file. T03 extended execution to legs B/C
 * for Group 1's kernel entries (src/kernels.js) — each entry's own
 * `run(ctx)` now owns its leg's execution mechanics, so this command no
 * longer hardcodes a leg-A-only gate. Full orchestration hygiene
 * (interleaved legs, cooldowns, multi-group scheduling policy) still
 * lands in T13; this command remains the minimal slice that makes the
 * registry -> results pipeline real end to end.
 */

import { requireAppleSilicon } from '../arm64-gate.js';
import { captureMachine, captureToolchain, captureGitSha, getPowerSource } from '../provenance.js';
import { benchmarksForGroups } from '../registry.js';
import { summarize, discardWarmups } from '../stats.js';
import { validateAgainstV1 } from '../schema.js';
import { writeResults } from '../results-writer.js';

// Registering built-in benchmarks as a side effect of importing them.
import '../benchmarks/demo.js';
import { registerKernelBenchmarks } from '../kernels.js';
registerKernelBenchmarks();
import { registerRigSceneBenchmarks } from '../rig-scenes.js';
registerRigSceneBenchmarks();

const WARMUP_DISCARDS = 2;

/**
 * @param {{ groups?: string, legs?: string, config?: string, label?: string, endurance?: boolean, allowBattery?: boolean }} flags
 */
export async function runCommand(flags) {
  requireAppleSilicon();

  const groups = parseGroups(flags.groups);
  const legs = parseLegs(flags.legs);
  const label = flags.label ?? 'unlabeled';
  const config = /** @type {'tuned'|'default'|'both'} */ (flags.config ?? 'tuned');

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

  // --- Execute registered benchmarks for the requested groups/legs ---
  const entries = benchmarksForGroups(groups).filter((e) =>
    e.legs.some((l) => legs.includes(l)),
  );

  /** @type {import('../types.js').BenchmarkResult[]} */
  const benchmarks = [];
  /** @type {import('../types.js').Skip[]} */
  const skipped = [];

  for (const entry of entries) {
    for (const leg of entry.legs.filter((l) => legs.includes(l))) {
      // T01 scaffolded leg A only; each entry's own `run(ctx)` is now
      // responsible for its leg's execution mechanics (T03's kernel
      // entries, registered via src/kernels.js, handle legs A/B/C
      // themselves — local exec, adb push+shell, and simctl spawn
      // respectively — rather than routing through a generic `ctx.exec`).
      // An entry that declares support for a leg it can't actually run
      // (e.g. no device attached) throws from `run(ctx)` and lands in the
      // catch below as a skip with that leg's real reason, instead of a
      // blanket "not wired up" skip for every non-A leg.
      try {
        /** @type {import('../types.js').RunContext} */
        const ctx = {
          leg,
          config: config === 'both' ? 'tuned' : config,
          exec: async (cmd, args) => {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const run = promisify(execFile);
            return run(cmd, args, { encoding: 'utf8' });
          },
        };
        const rawSamples = await entry.run(ctx);
        const { kept, discarded } = discardWarmups(rawSamples, WARMUP_DISCARDS);
        const summary = summarize(kept, discarded);
        benchmarks.push({
          group: entry.group,
          id: entry.id,
          leg,
          config: config === 'both' ? 'tuned' : config,
          unit: entry.unit,
          ...summary,
        });
      } catch (/** @type {any} */ err) {
        skipped.push({ id: entry.id, leg, reason: err?.message ?? String(err) });
      }
    }
  }

  // --- Assemble + validate + write ---
  const resultsObject = {
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
    notes: batteryOverrideUsed ? 'Ran on battery power via --allow-battery override.' : '',
  };

  const { valid, errors } = await validateAgainstV1(resultsObject);
  if (!valid) {
    console.error('emu-bench: internal error — results object failed schema validation:');
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  const writtenPath = await writeResults(resultsObject, { chip: machine.chip, label });
  console.log(`emu-bench: wrote ${writtenPath}`);
  if (skipped.length > 0) {
    console.log(`emu-bench: ${skipped.length} skip(s) recorded (see "skipped" in the results file).`);
  }
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
