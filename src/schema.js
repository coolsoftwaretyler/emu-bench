// @ts-check
/**
 * Minimal JSON Schema (draft-07 subset) validator, hand-rolled because the
 * suite ships zero runtime dependencies (SPEC.md §5). Supports exactly the
 * keywords `schema/v1.json` uses: type, required, additionalProperties,
 * properties, items, enum, const, minimum, maximum, format (date-time only).
 * This is not a general-purpose JSON Schema implementation — it is sized to
 * this one schema and will need extending if the schema grows keywords.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * @param {unknown} value
 * @param {any} schema
 * @param {string} path
 * @param {string[]} errors
 */
function validateNode(value, schema, path, errors) {
  if (schema.const !== undefined) {
    if (value !== schema.const) {
      errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    }
    return;
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
      return;
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${describeType(value)}`);
      return;
    }
  }

  if (schema.format === 'date-time' && typeof value === 'string') {
    if (Number.isNaN(Date.parse(value))) {
      errors.push(`${path}: expected date-time format, got ${JSON.stringify(value)}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} is less than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} is greater than maximum ${schema.maximum}`);
    }
  }

  if (schema.type === 'object' || (value !== null && typeof value === 'object' && !Array.isArray(value) && schema.properties)) {
    validateObject(/** @type {Record<string, unknown>} */ (value), schema, path, errors);
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      validateNode(item, schema.items, `${path}[${i}]`, errors);
    });
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {any} schema
 * @param {string} path
 * @param {string[]} errors
 */
function validateObject(value, schema, path, errors) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return; // type check above already reported this
  }

  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      errors.push(`${path}: missing required property "${key}"`);
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in value) {
      validateNode(value[key], propSchema, path ? `${path}.${key}` : key, errors);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push(`${path}: unexpected additional property "${key}"`);
      }
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} type
 * @returns {boolean}
 */
function matchesType(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** @param {unknown} value @returns {string} */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validates `data` against a JSON Schema object (already parsed).
 * @param {unknown} data
 * @param {any} schema
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(data, schema) {
  const errors = [];
  validateNode(data, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

const schemaV1Path = fileURLToPath(new URL('../schema/v1.json', import.meta.url));

/**
 * Loads `schema/v1.json` from disk.
 * @returns {Promise<any>}
 */
export async function loadSchemaV1() {
  const raw = await readFile(schemaV1Path, 'utf8');
  return JSON.parse(raw);
}

/**
 * Validates `data` against `schema/v1.json`.
 * @param {unknown} data
 * @returns {Promise<{ valid: boolean, errors: string[] }>}
 */
export async function validateAgainstV1(data) {
  const schema = await loadSchemaV1();
  return validate(data, schema);
}
