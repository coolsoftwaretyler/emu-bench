// @ts-check
/**
 * `emu-bench aggregate` (SPEC.md §5 `aggregate`, §2 decision D5; ticket
 * T14 scope). The report generator: reads every `results/*.json`,
 * validates each against `schema/v1.json`, rejects (lists, doesn't crash)
 * runs with incomplete provenance or a `schemaVersion` mismatch, groups
 * the survivors by chip class, and renders three tables — this is also
 * what the writeup's tables come from, so no number is ever hand-copied
 * (SPEC.md §5).
 *
 * "Incomplete provenance" (ticket line 13) is exactly what schema
 * validation already checks: `machine`/`toolchain`/`run` are `required`
 * with `additionalProperties: false` in schema/v1.json, so a file missing
 * any provenance field already fails `validateAgainstV1` — there is no
 * separate provenance check to write.
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { requireAppleSilicon } from '../arm64-gate.js';
import { validateAgainstV1 } from '../schema.js';
import { median } from '../stats.js';

const resultsDir = fileURLToPath(new URL('../../results/', import.meta.url));

/** SPEC.md §5 `run`, PLAN.md §5 "Config policy": the tuned-vs-default
 * headline subset, re-run on leg B only (src/commands/run.js's own
 * HEADLINE_SUBSET_IDS — duplicated here rather than imported because
 * run.js pulls in the entire benchmark registry as a side effect of
 * import, which `aggregate` has no reason to load). */
const HEADLINE_SUBSET_IDS = [
  'boot.cold',
  'list.scroll',
  'sqlite.insert_fsync',
  'install.rig.fresh',
  'install.rig.upgrade',
];

/** PLAN.md §5 "flag CV > 10% as unstable"; SPEC.md §12. */
const CV_FLAG_THRESHOLD = 0.1;

/**
 * @param {{ out?: string }} flags
 */
export async function aggregateCommand(flags) {
  requireAppleSilicon();

  const outFormat = flags.out === 'csv' ? 'csv' : 'md';

  const files = await listResultsFiles();
  if (files.length === 0) {
    console.log('emu-bench aggregate: no results/*.json files found — nothing to aggregate.');
    return;
  }

  const { accepted, rejected } = await loadAndValidate(files);

  printRejections(rejected);

  if (accepted.length === 0) {
    console.log('\nemu-bench aggregate: every results file was rejected — no valid runs to aggregate.');
    return;
  }

  const byChip = groupByChip(accepted);

  const mainTableRows = buildMainTable(byChip);
  const deltaTableRows = buildDeltaTable(byChip);
  const appendixRows = buildAppendix(accepted);

  const render = outFormat === 'csv' ? renderCsv : renderMarkdown;

  console.log('\n' + render.mainTable(mainTableRows));
  console.log('\n' + render.deltaTable(deltaTableRows));
  console.log('\n' + render.appendix(appendixRows));
}

/**
 * @returns {Promise<string[]>} absolute paths of every `results/*.json` file
 *   (not recursive — `results/.scratch/` and `results/logs/` are
 *   deliberately excluded, matching what a community PR actually commits:
 *   `.scratch/` holds `*.local.json` dev-loop debug fixtures, gitignored
 *   per the repo's own `.gitignore`, never a submitted results file).
 */
async function listResultsFiles() {
  const entries = await readdir(resultsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => path.join(resultsDir, e.name))
    .sort();
}

/**
 * @param {string[]} files
 * @returns {Promise<{ accepted: { file: string, data: any }[], rejected: { file: string, reason: string }[] }>}
 */
async function loadAndValidate(files) {
  /** @type {{ file: string, data: any }[]} */
  const accepted = [];
  /** @type {{ file: string, reason: string }[] }} */
  const rejected = [];

  for (const file of files) {
    const relFile = path.relative(process.cwd(), file);
    let parsed;
    try {
      const raw = await readFile(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch (/** @type {any} */ err) {
      rejected.push({ file: relFile, reason: `not valid JSON: ${err?.message ?? err}` });
      continue;
    }

    const { valid, errors } = await validateAgainstV1(parsed);
    if (!valid) {
      rejected.push({ file: relFile, reason: `schema/v1.json validation failed: ${errors.join('; ')}` });
      continue;
    }

    accepted.push({ file: relFile, data: parsed });
  }

  return { accepted, rejected };
}

/**
 * @param {{ file: string, reason: string }[]} rejected
 */
function printRejections(rejected) {
  if (rejected.length === 0) {
    console.log(`emu-bench aggregate: all results files valid, none rejected.`);
    return;
  }
  console.log(`emu-bench aggregate: ${rejected.length} results file(s) rejected:`);
  for (const r of rejected) {
    console.log(`  ${r.file}: ${r.reason}`);
  }
}

/**
 * Groups accepted runs by `machine.chip` (ticket line 13: "group by chip
 * class"; `machine.chip` — e.g. "Apple M3 Max" — is the schema's own chip
 * fingerprint field, SPEC.md §7 `machine`, so it *is* the chip class with
 * no separate taxonomy to invent).
 * @param {{ file: string, data: any }[]} accepted
 * @returns {Map<string, { file: string, data: any }[]>}
 */
export function groupByChip(accepted) {
  /** @type {Map<string, { file: string, data: any }[]>} */
  const byChip = new Map();
  for (const run of accepted) {
    const chip = run.data.machine.chip;
    const list = byChip.get(chip) ?? [];
    list.push(run);
    byChip.set(chip, list);
  }
  return byChip;
}

/**
 * @typedef {Object} Cell
 * @property {number} group
 * @property {string} id
 * @property {string} leg
 * @property {string} config
 * @property {string} unit
 * @property {number} medianValue recomputed from `samples[]`, never the
 *   file's own persisted `median` (ticket line 14: "recomputed from raw
 *   samples" — this is the guarantee that backs it).
 * @property {string} sourceFile
 * @property {string} sourceTimestamp
 */

/**
 * Flattens every run's `benchmarks[]` into `Cell`s, recomputing each
 * cell's median directly from `samples[]` (never trusting the file's own
 * persisted `median` field — ticket line 14). When more than one run
 * reports the identical `(chip, group, id, leg, config)` cell (e.g. an
 * early dev-loop check file and a later full reference run both cover
 * `kernel.sha256|a|tuned`), the most recent run by `run.timestamp` wins —
 * the same rule a community PR replacing a prior submission would expect:
 * a later, presumably corrected or more complete run supersedes an
 * earlier partial one for any cell they both cover, rather than the two
 * being silently averaged together (which would conflate runs of
 * different sample counts/conditions into one number).
 * @param {{ file: string, data: any }[]} runs one chip's accepted runs
 * @returns {Map<string, Cell>} keyed by `group\x1fid\x1fleg\x1fconfig`
 */
export function flattenCells(runs) {
  /** @type {Map<string, Cell>} */
  const cells = new Map();
  // Oldest-first, so "later run wins" is just "last write wins" below.
  const sorted = [...runs].sort(
    (a, b) => Date.parse(a.data.run.timestamp) - Date.parse(b.data.run.timestamp),
  );
  for (const run of sorted) {
    for (const b of run.data.benchmarks) {
      const key = `${b.group}\x1f${b.id}\x1f${b.leg}\x1f${b.config ?? ''}`;
      cells.set(key, {
        group: b.group,
        id: b.id,
        leg: b.leg,
        config: b.config ?? '',
        unit: b.unit,
        medianValue: median(b.samples),
        sourceFile: run.file,
        sourceTimestamp: run.data.run.timestamp,
      });
    }
  }
  return cells;
}

/**
 * @typedef {Object} MainTableRow
 * @property {string} chip
 * @property {number} group
 * @property {string} id
 * @property {string} config
 * @property {string} unit
 * @property {number|null} nativeMedian leg A median, if leg A exists for this id
 * @property {number|null} emulatorMedian leg B median
 * @property {number|null} simulatorMedian leg C median
 * @property {number|null} baRatio emulator/native, null when leg A absent
 * @property {number|null} caRatio simulator/native, null when leg A absent
 * @property {number|null} cbRatio simulator/emulator, when leg A absent for
 *   this id (SPEC.md §9: the rig app has no macOS build, so Groups 2/3/5
 *   have no leg A at all — B-vs-C is the only ratio those groups can ever
 *   report; PLAN.md §3 "Which legs run what" confirms the same for
 *   Groups 6-7, rendered as absolutes instead, never as this ratio).
 * @property {boolean} isAbsoluteGroup true for groups 6-7 (SPEC.md §5:
 *   "absolutes for Groups 6-7" — rendered as plain per-leg medians, no
 *   ratio column at all).
 */

/**
 * Builds the main comparison table (ticket line 14 item 1; SPEC.md §5,
 * §1 "ratios for Groups 1-5 ... absolutes for Groups 6-7"). One row per
 * `(chip, group, id, config)` — legs are columns, not rows, so a ratio can
 * be computed across them.
 * @param {Map<string, { file: string, data: any }[]>} byChip
 * @returns {MainTableRow[]}
 */
export function buildMainTable(byChip) {
  /** @type {MainTableRow[]} */
  const rows = [];
  for (const [chip, runs] of byChip) {
    const cells = flattenCells(runs);
    /** @type {Map<string, Cell[]>} keyed by group\x1fid\x1fconfig */
    const byIdConfig = new Map();
    for (const cell of cells.values()) {
      const key = `${cell.group}\x1f${cell.id}\x1f${cell.config}`;
      const list = byIdConfig.get(key) ?? [];
      list.push(cell);
      byIdConfig.set(key, list);
    }
    for (const [, legCells] of byIdConfig) {
      const first = legCells[0];
      const isAbsoluteGroup = first.group === 6 || first.group === 7;
      const byLeg = Object.fromEntries(legCells.map((c) => [c.leg, c.medianValue]));
      const nativeMedian = byLeg.a ?? null;
      const emulatorMedian = byLeg.b ?? null;
      const simulatorMedian = byLeg.c ?? null;
      rows.push({
        chip,
        group: first.group,
        id: first.id,
        config: first.config,
        unit: first.unit,
        nativeMedian,
        emulatorMedian,
        simulatorMedian,
        // `nativeMedian !== null` (not a truthiness check): a real leg-A
        // measurement can legitimately median to exactly 0 (e.g. an
        // operation fast enough to round to 0ms) -- `0` is present data,
        // not "leg A absent," and must take the B/A|C/A branch just like
        // any other real value (ratio() itself already guards the
        // denominator-is-0 case separately, returning null for *that*).
        baRatio: !isAbsoluteGroup && nativeMedian !== null ? ratio(emulatorMedian, nativeMedian) : null,
        caRatio: !isAbsoluteGroup && nativeMedian !== null ? ratio(simulatorMedian, nativeMedian) : null,
        cbRatio:
          !isAbsoluteGroup && nativeMedian === null ? ratio(simulatorMedian, emulatorMedian) : null,
        isAbsoluteGroup,
      });
    }
  }
  rows.sort((a, b) => a.chip.localeCompare(b.chip) || a.group - b.group || a.id.localeCompare(b.id) || a.config.localeCompare(b.config));
  return rows;
}

/**
 * @param {number|null} numerator
 * @param {number|null} denominator
 * @returns {number|null}
 */
function ratio(numerator, denominator) {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * @typedef {Object} DeltaRow
 * @property {string} chip
 * @property {string} id
 * @property {string} unit
 * @property {number|null} tunedMedian leg B, config tuned
 * @property {number|null} defaultMedian leg B, config default
 * @property {number|null} deltaRatio default/tuned — >1 means default is slower
 */

/**
 * Builds the tuned-vs-default delta table (ticket line 15; SPEC.md §5
 * `run`'s headline subset). Leg B only — SPEC.md §6: the simulator "has no
 * performance knobs to tune," so there is no default/tuned distinction on
 * leg C to compare.
 * @param {Map<string, { file: string, data: any }[]>} byChip
 * @returns {DeltaRow[]}
 */
export function buildDeltaTable(byChip) {
  /** @type {DeltaRow[]} */
  const rows = [];
  for (const [chip, runs] of byChip) {
    const cells = flattenCells(runs);
    for (const id of HEADLINE_SUBSET_IDS) {
      const tuned = findCell(cells, id, 'b', 'tuned');
      const def = findCell(cells, id, 'b', 'default');
      if (!tuned && !def) continue; // this chip never ran the headline subset
      rows.push({
        chip,
        id,
        unit: (tuned ?? def)?.unit ?? '',
        tunedMedian: tuned?.medianValue ?? null,
        defaultMedian: def?.medianValue ?? null,
        deltaRatio: ratio(def?.medianValue ?? null, tuned?.medianValue ?? null),
      });
    }
  }
  return rows;
}

/**
 * @param {Map<string, Cell>} cells
 * @param {string} id
 * @param {string} leg
 * @param {string} config
 * @returns {Cell|undefined}
 */
function findCell(cells, id, leg, config) {
  for (const c of cells.values()) {
    if (c.id === id && c.leg === leg && c.config === config) return c;
  }
  return undefined;
}

/**
 * @typedef {Object} AppendixRow
 * @property {string} file
 * @property {string} chip
 * @property {string} label
 * @property {string} timestamp
 * @property {number} benchmarkCount
 * @property {number} cvFlaggedCount
 * @property {{ id: string, leg: string, cv: number }[]} cvFlagged
 * @property {{ id: string, leg: string, reason: string }[]} skipped
 */

/**
 * Builds the per-machine appendix (ticket line 16: "CV flags and skips").
 * One row per accepted results *file* (not per chip) — the point of the
 * appendix is exactly to show what each individual run reported, which
 * the chip-grouped main/delta tables deliberately collapse away.
 * @param {{ file: string, data: any }[]} accepted
 * @returns {AppendixRow[]}
 */
export function buildAppendix(accepted) {
  return accepted
    .map((run) => {
      const benchmarks = run.data.benchmarks ?? [];
      const cvFlagged = benchmarks
        .filter((/** @type {any} */ b) => b.cvFlagged || b.cv > CV_FLAG_THRESHOLD)
        .map((/** @type {any} */ b) => ({ id: b.id, leg: b.leg, cv: b.cv }));
      return {
        file: run.file,
        chip: run.data.machine.chip,
        label: run.data.run.label,
        timestamp: run.data.run.timestamp,
        benchmarkCount: benchmarks.length,
        cvFlaggedCount: cvFlagged.length,
        cvFlagged,
        skipped: run.data.skipped ?? [],
      };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// --- Rendering -------------------------------------------------------

/**
 * @param {number|null} n
 * @param {number} [digits]
 * @returns {string}
 */
function fmtNum(n, digits = 3) {
  if (n === null || n === undefined) return '—';
  return Number(n.toFixed(digits)).toString();
}

/**
 * @param {number|null} r
 * @returns {string}
 */
function fmtRatio(r) {
  if (r === null || r === undefined) return '—';
  return `${r.toFixed(2)}×`;
}

export const renderMarkdown = {
  /** @param {MainTableRow[]} rows */
  mainTable(rows) {
    const lines = [
      '## Main table — Groups 1–5 ratios, Groups 6–7 absolutes',
      '',
      '| Chip | Group | Benchmark | Config | Unit | Native (A) | Emulator (B) | Simulator (C) | B/A | C/A | C/B |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    if (rows.length === 0) lines.push('| _no data_ | | | | | | | | | | |');
    for (const r of rows) {
      lines.push(
        `| ${r.chip} | ${r.group} | ${r.id} | ${r.config} | ${r.unit} | ${fmtNum(r.nativeMedian)} | ${fmtNum(r.emulatorMedian)} | ${fmtNum(r.simulatorMedian)} | ${r.isAbsoluteGroup ? '—' : fmtRatio(r.baRatio)} | ${r.isAbsoluteGroup ? '—' : fmtRatio(r.caRatio)} | ${r.isAbsoluteGroup ? '—' : fmtRatio(r.cbRatio)} |`,
      );
    }
    return lines.join('\n');
  },
  /** @param {DeltaRow[]} rows */
  deltaTable(rows) {
    const lines = [
      '## Tuned-vs-default delta (headline subset, leg B)',
      '',
      '| Chip | Benchmark | Unit | Tuned | Default | Default/Tuned |',
      '|---|---|---|---|---|---|',
    ];
    if (rows.length === 0) lines.push('| _no data_ | | | | | |');
    for (const r of rows) {
      lines.push(
        `| ${r.chip} | ${r.id} | ${r.unit} | ${fmtNum(r.tunedMedian)} | ${fmtNum(r.defaultMedian)} | ${fmtRatio(r.deltaRatio)} |`,
      );
    }
    return lines.join('\n');
  },
  /** @param {AppendixRow[]} rows */
  appendix(rows) {
    const lines = ['## Per-machine appendix', ''];
    if (rows.length === 0) lines.push('_no data_');
    for (const r of rows) {
      lines.push(`### ${r.file}`);
      lines.push('');
      lines.push(`- Chip: ${r.chip}`);
      lines.push(`- Label: ${r.label}`);
      lines.push(`- Timestamp: ${r.timestamp}`);
      lines.push(`- Benchmarks: ${r.benchmarkCount}`);
      lines.push(`- CV-flagged (>${(CV_FLAG_THRESHOLD * 100).toFixed(0)}%): ${r.cvFlaggedCount}`);
      for (const f of r.cvFlagged) {
        lines.push(`  - ${f.id} (leg ${f.leg}): CV ${(f.cv * 100).toFixed(1)}%`);
      }
      lines.push(`- Skipped: ${r.skipped.length}`);
      for (const s of r.skipped) {
        lines.push(`  - ${s.id} (leg ${s.leg}): ${s.reason}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  },
};

/**
 * @param {string} field
 * @returns {string}
 */
function csvEscape(field) {
  const s = String(field);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {(string|number)[][]} rows including the header row
 * @returns {string}
 */
function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

export const renderCsv = {
  /** @param {MainTableRow[]} rows */
  mainTable(rows) {
    const header = ['chip', 'group', 'id', 'config', 'unit', 'native_a', 'emulator_b', 'simulator_c', 'b_over_a', 'c_over_a', 'c_over_b'];
    const body = rows.map((r) => [
      r.chip,
      r.group,
      r.id,
      r.config,
      r.unit,
      r.nativeMedian ?? '',
      r.emulatorMedian ?? '',
      r.simulatorMedian ?? '',
      r.isAbsoluteGroup ? '' : r.baRatio ?? '',
      r.isAbsoluteGroup ? '' : r.caRatio ?? '',
      r.isAbsoluteGroup ? '' : r.cbRatio ?? '',
    ]);
    return toCsv([header, ...body]);
  },
  /** @param {DeltaRow[]} rows */
  deltaTable(rows) {
    const header = ['chip', 'id', 'unit', 'tuned', 'default', 'default_over_tuned'];
    const body = rows.map((r) => [r.chip, r.id, r.unit, r.tunedMedian ?? '', r.defaultMedian ?? '', r.deltaRatio ?? '']);
    return toCsv([header, ...body]);
  },
  /** @param {AppendixRow[]} rows */
  appendix(rows) {
    const header = ['file', 'chip', 'label', 'timestamp', 'benchmark_count', 'cv_flagged_count', 'cv_flagged_ids', 'skip_count', 'skip_ids'];
    const body = rows.map((r) => [
      r.file,
      r.chip,
      r.label,
      r.timestamp,
      r.benchmarkCount,
      r.cvFlaggedCount,
      r.cvFlagged.map((f) => `${f.id}(${f.leg})`).join(';'),
      r.skipped.length,
      r.skipped.map((s) => `${s.id}(${s.leg})`).join(';'),
    ]);
    return toCsv([header, ...body]);
  },
};
