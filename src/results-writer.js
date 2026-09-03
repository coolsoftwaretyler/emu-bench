// @ts-check
/**
 * Results writer (SPEC.md §1 step 6, §4, §7). Writes
 * `results/<chip-slug>-<date>-<label>.json`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const resultsDir = fileURLToPath(new URL('../results/', import.meta.url));

/**
 * Turns a chip string like "Apple M3 Max" into a filename-safe slug like
 * "apple-m3-max".
 * @param {string} chip
 * @returns {string}
 */
export function slugifyChip(chip) {
  return chip
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @param {Date} date
 * @returns {string} YYYY-MM-DD
 */
export function dateSlug(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {{ chip: string, date: Date, label: string }} args
 * @returns {string} filename only, e.g. "apple-m3-max-2026-08-29-smoke.json"
 */
export function resultsFilename({ chip, date, label }) {
  const chipSlug = slugifyChip(chip);
  const day = dateSlug(date);
  const labelSlug = label.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${chipSlug}-${day}-${labelSlug}.json`;
}

/**
 * Writes the results object to `results/<chip-slug>-<date>-<label>.json`,
 * creating the `results/` directory if needed.
 * @param {object} resultsObject the full schema-shaped results object
 * @param {{ chip: string, date?: Date, label: string }} args
 * @returns {Promise<string>} absolute path written
 */
export async function writeResults(resultsObject, { chip, date = new Date(), label }) {
  await mkdir(resultsDir, { recursive: true });
  const filename = resultsFilename({ chip, date, label });
  const fullPath = path.join(resultsDir, filename);
  await writeFile(fullPath, JSON.stringify(resultsObject, null, 2) + '\n', 'utf8');
  return fullPath;
}
