// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByChip,
  flattenCells,
  buildMainTable,
  buildDeltaTable,
  buildAppendix,
  renderMarkdown,
  renderCsv,
} from './aggregate.js';

/**
 * A minimal accepted-run fixture: `{file, data}` where `data` carries just
 * the fields aggregate.js's pure functions actually read (run.timestamp/
 * label, machine.chip, benchmarks[], skipped[]) — not a full schema-valid
 * results object (schema validation itself is exercised in
 * src/schema.test.js, not here).
 * @param {{ file?: string, chip?: string, timestamp?: string, label?: string, benchmarks?: any[], skipped?: any[] }} [overrides]
 */
function runFixture(overrides = {}) {
  return {
    file: overrides.file ?? 'results/fixture.json',
    data: {
      run: { timestamp: overrides.timestamp ?? '2026-08-29T00:00:00.000Z', label: overrides.label ?? 'fixture' },
      machine: { chip: overrides.chip ?? 'Apple M3 Max' },
      benchmarks: overrides.benchmarks ?? [],
      skipped: overrides.skipped ?? [],
    },
  };
}

/**
 * @param {{ group: number, id: string, leg: string, config?: string|null, unit?: string, samples: number[], cv?: number, cvFlagged?: boolean }} args
 */
function benchRow({ group, id, leg, config = 'tuned', unit = 'ms', samples, cv, cvFlagged }) {
  return {
    group,
    id,
    leg,
    config,
    unit,
    samples,
    median: -999, // deliberately wrong -- proves the table uses samples, not this
    ...(cv !== undefined ? { cv } : {}),
    ...(cvFlagged !== undefined ? { cvFlagged } : {}),
  };
}

test('groupByChip groups accepted runs by machine.chip', () => {
  const runs = [runFixture({ chip: 'Apple M3 Max' }), runFixture({ chip: 'Apple M1' }), runFixture({ chip: 'Apple M3 Max' })];
  const byChip = groupByChip(runs);
  assert.equal(byChip.size, 2);
  assert.equal(byChip.get('Apple M3 Max').length, 2);
  assert.equal(byChip.get('Apple M1').length, 1);
});

test('flattenCells recomputes median from samples, ignoring the file\'s own persisted median field', () => {
  const runs = [
    runFixture({
      benchmarks: [benchRow({ group: 1, id: 'kernel.sha256', leg: 'a', samples: [10, 20, 30] })],
    }),
  ];
  const cells = flattenCells(runs);
  const cell = cells.get('1\x1fkernel.sha256\x1fa\x1ftuned');
  assert.equal(cell.medianValue, 20, 'median of [10,20,30] is 20, not the fixture\'s bogus median: -999');
});

test('flattenCells: when two runs report the same cell, the run with the later run.timestamp wins', () => {
  const older = runFixture({
    timestamp: '2026-08-29T00:00:00.000Z',
    benchmarks: [benchRow({ group: 1, id: 'kernel.sha256', leg: 'a', samples: [100, 100, 100] })],
  });
  const newer = runFixture({
    timestamp: '2026-08-30T00:00:00.000Z',
    benchmarks: [benchRow({ group: 1, id: 'kernel.sha256', leg: 'a', samples: [5, 5, 5] })],
  });
  // Order in the input array is deliberately older-after-newer, to prove
  // the winner is chosen by timestamp, not by array/iteration order.
  const cellsA = flattenCells([newer, older]);
  const cellsB = flattenCells([older, newer]);
  assert.equal(cellsA.get('1\x1fkernel.sha256\x1fa\x1ftuned').medianValue, 5);
  assert.equal(cellsB.get('1\x1fkernel.sha256\x1fa\x1ftuned').medianValue, 5);
});

test('buildMainTable computes B/A and C/A ratios for a Group 1 id with all three legs', () => {
  const runs = [
    runFixture({
      benchmarks: [
        benchRow({ group: 1, id: 'kernel.sha256', leg: 'a', samples: [100] }),
        benchRow({ group: 1, id: 'kernel.sha256', leg: 'b', samples: [200] }),
        benchRow({ group: 1, id: 'kernel.sha256', leg: 'c', samples: [110] }),
      ],
    }),
  ];
  const rows = buildMainTable(groupByChip(runs));
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.nativeMedian, 100);
  assert.equal(row.emulatorMedian, 200);
  assert.equal(row.simulatorMedian, 110);
  assert.equal(row.baRatio, 2, 'B/A = 200/100');
  assert.ok(Math.abs(row.caRatio - 1.1) < 1e-9, 'C/A = 110/100');
  assert.equal(row.cbRatio, null, 'C/B is only populated when leg A is absent for this id');
  assert.equal(row.isAbsoluteGroup, false);
});

test('buildMainTable computes B/A when the leg-A median is exactly 0 (a real fast-op measurement, not "leg A absent")', () => {
  const runs = [
    runFixture({
      benchmarks: [
        benchRow({ group: 1, id: 'kernel.clock_gettime_loop', leg: 'a', samples: [0, 0, 0] }),
        benchRow({ group: 1, id: 'kernel.clock_gettime_loop', leg: 'b', samples: [5] }),
      ],
    }),
  ];
  const rows = buildMainTable(groupByChip(runs));
  const row = rows[0];
  assert.equal(row.nativeMedian, 0, 'a real leg-A median of 0 must be preserved, not treated as missing');
  // ratio() itself returns null when the denominator is 0 (division by
  // zero is not a valid ratio) -- but the *branch selection* above it
  // must still recognize leg A as present, not silently fall through to
  // the C/B branch meant for "no leg A at all".
  assert.equal(row.baRatio, null, 'B/0 is not a valid ratio, but this is still the B/A branch (denominator-is-zero), not the C/B fallback');
  assert.equal(row.cbRatio, null, 'must NOT take the C/B fallback branch just because nativeMedian is falsy -- leg A is present');
});

test('buildMainTable falls back to C/B when leg A does not exist for an id (Groups 2/3/5 -- no macOS rig build)', () => {
  const runs = [
    runFixture({
      benchmarks: [
        benchRow({ group: 2, id: 'hermes.json_parse', leg: 'b', samples: [30] }),
        benchRow({ group: 2, id: 'hermes.json_parse', leg: 'c', samples: [15] }),
      ],
    }),
  ];
  const rows = buildMainTable(groupByChip(runs));
  const row = rows[0];
  assert.equal(row.nativeMedian, null);
  assert.equal(row.baRatio, null);
  assert.equal(row.caRatio, null);
  assert.equal(row.cbRatio, 0.5, 'C/B = 15/30');
});

test('buildMainTable never computes a ratio for Groups 6-7 (absolutes only)', () => {
  const runs = [
    runFixture({
      benchmarks: [
        benchRow({ group: 6, id: 'boot.cold', leg: 'b', unit: 's', samples: [12] }),
        benchRow({ group: 6, id: 'boot.cold', leg: 'c', unit: 's', samples: [4] }),
      ],
    }),
  ];
  const rows = buildMainTable(groupByChip(runs));
  const row = rows[0];
  assert.equal(row.isAbsoluteGroup, true);
  assert.equal(row.baRatio, null);
  assert.equal(row.caRatio, null);
  assert.equal(row.cbRatio, null, 'absolute groups render medians only, never a C/B fallback ratio either');
  assert.equal(row.emulatorMedian, 12);
  assert.equal(row.simulatorMedian, 4);
});

test('buildMainTable keeps tuned and default configs of the same id as separate rows', () => {
  const runs = [
    runFixture({
      benchmarks: [
        benchRow({ group: 6, id: 'boot.cold', leg: 'b', config: 'tuned', unit: 's', samples: [12] }),
        benchRow({ group: 6, id: 'boot.cold', leg: 'b', config: 'default', unit: 's', samples: [14] }),
      ],
    }),
  ];
  const rows = buildMainTable(groupByChip(runs));
  assert.equal(rows.length, 2);
  const configs = rows.map((r) => r.config).sort();
  assert.deepEqual(configs, ['default', 'tuned']);
});

test('buildDeltaTable compares leg-B tuned vs default for the headline subset only', () => {
  const runs = [
    runFixture({
      benchmarks: [
        benchRow({ group: 6, id: 'boot.cold', leg: 'b', config: 'tuned', unit: 's', samples: [10] }),
        benchRow({ group: 6, id: 'boot.cold', leg: 'b', config: 'default', unit: 's', samples: [12] }),
        // Not in the headline subset -- must not appear in the delta table.
        benchRow({ group: 1, id: 'kernel.sha256', leg: 'b', config: 'tuned', samples: [1] }),
        benchRow({ group: 1, id: 'kernel.sha256', leg: 'b', config: 'default', samples: [2] }),
      ],
    }),
  ];
  const rows = buildDeltaTable(groupByChip(runs));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'boot.cold');
  assert.equal(rows[0].tunedMedian, 10);
  assert.equal(rows[0].defaultMedian, 12);
  assert.ok(Math.abs(rows[0].deltaRatio - 1.2) < 1e-9);
});

test('buildDeltaTable omits a headline-subset id this chip never ran', () => {
  const rows = buildDeltaTable(groupByChip([runFixture({ benchmarks: [] })]));
  assert.equal(rows.length, 0);
});

test('buildAppendix surfaces CV-flagged benchmarks and skips per source file', () => {
  const runs = [
    runFixture({
      file: 'results/example.json',
      benchmarks: [
        benchRow({ group: 5, id: 'sqlite.reads', leg: 'b', samples: [1, 2, 3], cv: 0.55, cvFlagged: true }),
        benchRow({ group: 5, id: 'sqlite.reads', leg: 'c', samples: [1, 1, 1], cv: 0.01 }),
      ],
      skipped: [{ id: 'touch.latency', leg: 'b', reason: 'maestro failed' }],
    }),
  ];
  const [row] = buildAppendix(runs);
  assert.equal(row.file, 'results/example.json');
  assert.equal(row.benchmarkCount, 2);
  assert.equal(row.cvFlaggedCount, 1);
  assert.equal(row.cvFlagged[0].id, 'sqlite.reads');
  assert.equal(row.skipped.length, 1);
  assert.equal(row.skipped[0].id, 'touch.latency');
});

test('renderMarkdown.mainTable renders a header and one row per benchmark, with — for null cells', () => {
  const runs = [runFixture({ benchmarks: [benchRow({ group: 2, id: 'hermes.strings', leg: 'b', samples: [5] })] })];
  const md = renderMarkdown.mainTable(buildMainTable(groupByChip(runs)));
  assert.match(md, /\| Chip \| Group \| Benchmark \|/);
  assert.match(md, /hermes\.strings/);
  assert.match(md, /—/, 'a leg with no data renders as an em-dash, not "null" or "undefined"');
});

test('renderCsv.mainTable produces a parseable CSV with a matching header', () => {
  const runs = [runFixture({ benchmarks: [benchRow({ group: 1, id: 'kernel.sha256', leg: 'a', samples: [7] })] })];
  const csv = renderCsv.mainTable(buildMainTable(groupByChip(runs)));
  const lines = csv.split('\n');
  assert.equal(lines[0], 'chip,group,id,config,unit,native_a,emulator_b,simulator_c,b_over_a,c_over_a,c_over_b');
  assert.match(lines[1], /^Apple M3 Max,1,kernel\.sha256,tuned,ms,7,,,,,$/);
});
