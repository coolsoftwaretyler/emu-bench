// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstV1, loadSchemaV1, validate } from './schema.js';

/**
 * A minimal, complete, schema-valid results object — used as the "good"
 * fixture that individual tests mutate to prove specific rejections.
 * @returns {any}
 */
function validResultsFixture() {
  return {
    schemaVersion: 1,
    run: { timestamp: new Date().toISOString(), label: 'test', suiteGitSha: 'abc123' },
    machine: {
      model: 'Mac15,8',
      chip: 'Apple M3 Max',
      pCores: 12,
      eCores: 4,
      ramGB: 48,
      macosVersion: '26.6.2',
      powerSource: 'AC',
      thermalPressureStart: 'nominal',
    },
    toolchain: {
      xcode: '26.6',
      iosRuntime: 'iOS 26.5',
      deviceType: 'iPhone 17 Pro',
      emulatorVersion: '37.1.11.0',
      systemImage: 'not installed',
      apiLevel: 0,
      ndk: 'not installed',
      rnVersion: 'n/a',
      maestro: '1.40.0',
      node: 'v24.2.0',
    },
    config: { avdTuned: {}, avdDefault: {} },
    benchmarks: [],
    skipped: [],
    notes: '',
  };
}

test('a complete results object validates against schema/v1.json', async () => {
  const { valid, errors } = await validateAgainstV1(validResultsFixture());
  assert.equal(valid, true, `expected valid, got errors: ${errors.join('; ')}`);
});

test('schema rejects a results file with missing machine.chip (acceptance criterion 3)', async () => {
  const fixture = validResultsFixture();
  delete fixture.machine.chip;
  const { valid, errors } = await validateAgainstV1(fixture);
  assert.equal(valid, false);
  assert.ok(
    errors.some((e) => e.includes('chip')),
    `expected an error mentioning "chip", got: ${JSON.stringify(errors)}`,
  );
});

test('schema rejects wrong schemaVersion', async () => {
  const fixture = validResultsFixture();
  fixture.schemaVersion = 2;
  const { valid } = await validateAgainstV1(fixture);
  assert.equal(valid, false);
});

test('schema rejects an additional unexpected top-level property', async () => {
  const fixture = validResultsFixture();
  fixture.unexpectedField = 'nope';
  const { valid, errors } = await validateAgainstV1(fixture);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('unexpectedField')));
});

test('loadSchemaV1 loads valid JSON from disk', async () => {
  const schema = await loadSchemaV1();
  assert.equal(schema.title, 'emu-bench results v1');
});

test('validate() enforces enum on benchmarks[].leg', () => {
  const fixture = validResultsFixture();
  fixture.benchmarks.push({
    group: 1,
    id: 'demo.noop_loop',
    leg: 'z', // invalid — must be a/b/c
    config: 'tuned',
    unit: 'ns_per_op',
    n: 1,
    warmupsDiscarded: 0,
    samples: [1],
    median: 1,
    p95: 1,
    p99: 1,
    cv: 0,
  });
  const schema = {
    type: 'object',
    properties: {
      benchmarks: {
        type: 'array',
        items: { type: 'object', properties: { leg: { enum: ['a', 'b', 'c'] } } },
      },
    },
  };
  const { valid } = validate(fixture, schema);
  assert.equal(valid, false);
});
