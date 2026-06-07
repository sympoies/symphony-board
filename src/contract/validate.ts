// Zero-dependency contract validator (LAYER 3 producer-side guard).
//
// The contract is the product surface, so an emit must NEVER ship a payload that
// violates packages/contract/contract.schema.json. We deliberately do NOT pull in ajv: the
// backend's defining property is ZERO runtime dependencies (and a minimal-trust,
// no-build posture), so we implement exactly the JSON Schema (draft 2020-12)
// subset that contract.schema.json actually uses:
//
//   * $ref to local "#/$defs/..."        * required
//   * type, incl. ["string","null"]      * additionalProperties:false
//   * enum (members may include null)     * properties
//   * pattern (strings)                   * items (arrays)
//   * format:date-time (pragmatic check)
//
// This is a PRODUCER guard (we validate what we emit). Consumers stay liberal in
// what they accept (ignore unknown fields) per docs/CONTRACT.md, so a future
// minor (additive) field never breaks an old reader.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface ValidationError {
  path: string; // JSON-pointer-ish path to the offending node ("" = root)
  message: string;
}

type Schema = Record<string, any>;

const __dirname = dirname(fileURLToPath(import.meta.url));
// The normative schema lives in the contract package
// (packages/contract/contract.schema.json, ../../packages/contract/ from
// src/contract/). Reading it by path — not via a bare-specifier import — keeps
// it the single source of truth AND works in the Docker image, which has no
// node_modules (the backend never resolves the package at runtime; see
// packages/contract/README.md). The Dockerfile copies packages/ for this read.
const SCHEMA_PATH = resolve(__dirname, "..", "..", "packages", "contract", "contract.schema.json");

let cachedSchema: Schema | null = null;

// Load + cache the normative contract schema from disk.
export function loadContractSchema(): Schema {
  if (cachedSchema === null) {
    cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Schema;
  }
  return cachedSchema;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number";
    default:
      return false;
  }
}

// Resolve a local JSON-pointer $ref ("#/$defs/item") against the root schema.
function resolveRef(ref: string, root: Schema): Schema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref (only local refs): ${ref}`);
  let node: any = root;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part];
    if (node === undefined) throw new Error(`$ref target not found: ${ref}`);
  }
  return node;
}

function validateNode(data: unknown, schema: Schema, root: Schema, path: string, errors: ValidationError[]): void {
  if (typeof schema.$ref === "string") {
    validateNode(data, resolveRef(schema.$ref, root), root, path, errors);
    return;
  }

  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(data, t))) {
      errors.push({ path, message: `expected type ${types.join("|")}, got ${typeName(data)}` });
      return; // a type mismatch makes deeper checks meaningless
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => e === data)) {
    errors.push({ path, message: `value ${JSON.stringify(data)} is not one of the allowed enum members` });
  }

  if (typeof data === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(data)) {
      errors.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
    // Pragmatic date-time check: a string Date.parse can read. Lenient on
    // purpose (provider timestamps vary) — paired with the type:string check it
    // still catches a non-date in a date field.
    if (schema.format === "date-time" && Number.isNaN(Date.parse(data))) {
      errors.push({ path, message: `string is not a valid date-time` });
    }
  }

  if (matchesType(data, "object")) {
    const obj = data as Record<string, unknown>;
    const props: Record<string, Schema> = schema.properties ?? {};
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in obj)) errors.push({ path: `${path}/${req}`, message: "missing required property" });
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push({ path: `${path}/${key}`, message: "additional property not allowed" });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validateNode(obj[key], sub, root, `${path}/${key}`, errors);
    }
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((el, i) => validateNode(el, schema.items, root, `${path}/${i}`, errors));
  }
}

// Validate `data` against the contract schema. Returns [] when valid, otherwise
// every violation found (does not throw). Pass an explicit schema for tests.
export function validateContract(data: unknown, schema: Schema = loadContractSchema()): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(data, schema, schema, "", errors);
  return errors;
}
