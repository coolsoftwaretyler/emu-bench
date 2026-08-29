// @ts-check
/**
 * Hard arm64 gate (SPEC.md §3, §5). emu-bench's methodology depends on
 * arm64-everywhere (native process, HVF guest, and Simulator process all
 * executing arm64 machine code with nothing instruction-translated). On
 * Intel Macs that premise doesn't hold, so every command refuses to run.
 */

import { execFileSync } from 'node:child_process';

/**
 * @returns {boolean} true when `sysctl -n hw.optional.arm64` reports `1`.
 */
export function isAppleSilicon() {
  try {
    const out = execFileSync('sysctl', ['-n', 'hw.optional.arm64'], {
      encoding: 'utf8',
    }).trim();
    return out === '1';
  } catch {
    // sysctl key absent entirely (e.g. very old macOS, or non-macOS host):
    // treat as "not Apple Silicon".
    return false;
  }
}

/**
 * Exits the process with an explanation if the host is not Apple Silicon.
 * Call this first, before any subcommand does real work.
 */
export function requireAppleSilicon() {
  if (isAppleSilicon()) return;
  console.error(
    [
      'emu-bench: this Mac is not Apple Silicon (arm64).',
      '',
      "emu-bench's methodology depends on arm64 everywhere: the native",
      'baseline, the Android emulator guest (via Hypervisor.framework),',
      'and the iOS Simulator all execute arm64 machine code with nothing',
      'instruction-translated. That premise does not hold on Intel Macs,',
      'so results would not be comparable to the rest of the reference',
      'dataset. See SPEC.md §3 (Non-goals).',
    ].join('\n'),
  );
  process.exit(1);
}
