// @ts-check
/**
 * Subcommand dispatch (SPEC.md §5). Single entrypoint `./bin/emu-bench
 * <command>`; this module parses argv and hands off to doctor/run/aggregate.
 */

import { doctorCommand } from './commands/doctor.js';
import { runCommand } from './commands/run.js';
import { aggregateCommand } from './commands/aggregate.js';

/**
 * Minimal flag parser: `--foo bar` -> `{foo: 'bar'}`, `--foo` (no value, or
 * followed by another flag) -> `{foo: true}`.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseFlags(argv) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/**
 * camelCases hyphenated flag names (`allow-battery` -> `allowBattery`) so
 * command modules can use idiomatic JS property names.
 * @param {Record<string, string|boolean>} flags
 * @returns {Record<string, string|boolean>}
 */
function camelizeFlags(flags) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (const [key, value] of Object.entries(flags)) {
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = value;
  }
  return out;
}

const USAGE = `emu-bench — Android Emulator vs iOS Simulator benchmark suite

Usage:
  emu-bench doctor [--json]
  emu-bench run [--groups 1-7] [--legs a,b,c] [--config tuned|default|both] [--label NAME] [--endurance] [--allow-battery] [--region x,y,w,h] [--photon-taps N]
  emu-bench aggregate [--out md|csv]

See SPEC.md §5 for full CLI surface.`;

/**
 * @param {string[]} argv process.argv.slice(2)
 */
export async function main(argv) {
  const [command, ...rest] = argv;
  const flags = camelizeFlags(parseFlags(rest));

  switch (command) {
    case 'doctor':
      await doctorCommand(/** @type {any} */ (flags));
      break;
    case 'run':
      await runCommand(/** @type {any} */ (flags));
      break;
    case 'aggregate':
      await aggregateCommand(/** @type {any} */ (flags));
      break;
    case undefined:
    case '--help':
    case '-h':
      console.log(USAGE);
      process.exit(command === undefined ? 1 : 0);
      break;
    default:
      console.error(`emu-bench: unknown command "${command}"\n`);
      console.error(USAGE);
      process.exit(1);
  }
}
