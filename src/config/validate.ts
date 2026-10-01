import { isAbsolute } from "node:path";
import { ConfigError } from "./errors.ts";

export type Table = Readonly<Record<string, unknown>>;

/** Dotted key path, e.g. ["linear", "keyring_service"]. */
export type KeyPath = readonly string[];

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** `[table] key` for nested keys, `key` for top-level ones. */
function describe(path: KeyPath): string {
  const last = path[path.length - 1] ?? "";
  if (path.length <= 1) return last;
  return `[${path.slice(0, -1).join(".")}] ${last}`;
}

export function fail(file: string, path: KeyPath, problem: string): ConfigError {
  return new ConfigError(file, path.join("."), `${file}: ${describe(path)} ${problem}`);
}

export function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function requireTable(parent: Table, name: string, file: string, parentPath: KeyPath = []): Table {
  const path = [...parentPath, name];
  if (!(name in parent)) throw fail(file, path, "is required");
  const value = parent[name];
  if (!isTable(value)) throw fail(file, path, "must be a table");
  return value;
}

export function rejectUnknownKeys(table: Table, allowed: readonly string[], file: string, path: KeyPath): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) throw fail(file, [...path, key], "is not a known key");
  }
}

function requireKey(table: Table, name: string, file: string, path: KeyPath): unknown {
  if (!(name in table)) throw fail(file, [...path, name], "is required");
  return table[name];
}

export function readString(table: Table, name: string, file: string, path: KeyPath): string {
  const full = [...path, name];
  const value = requireKey(table, name, file, path);
  if (typeof value !== "string") throw fail(file, full, "must be a string");
  if (value.trim() === "") throw fail(file, full, "must not be empty");
  return value;
}

export function readAbsolutePath(table: Table, name: string, file: string, path: KeyPath): string {
  const value = readString(table, name, file, path);
  if (!isAbsolute(value)) throw fail(file, [...path, name], "must be an absolute path");
  return value;
}

export function readHttpsUrl(table: Table, name: string, file: string, path: KeyPath): string {
  const value = readString(table, name, file, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail(file, [...path, name], "must be an https URL");
  }
  if (url.protocol !== "https:") throw fail(file, [...path, name], "must be an https URL");
  return value;
}

export function readPositiveInt(table: Table, name: string, file: string, path: KeyPath): number {
  const full = [...path, name];
  const value = requireKey(table, name, file, path);
  if (typeof value !== "number") throw fail(file, full, "must be an integer");
  if (!Number.isInteger(value) || value <= 0) throw fail(file, full, "must be a positive integer");
  return value;
}

export function readNonNegativeNumber(table: Table, name: string, file: string, path: KeyPath): number {
  const full = [...path, name];
  const value = requireKey(table, name, file, path);
  if (typeof value !== "number") throw fail(file, full, "must be a number");
  if (!Number.isFinite(value) || value < 0) throw fail(file, full, "must be a non-negative number");
  return value;
}

export function readStringArray(table: Table, name: string, file: string, path: KeyPath): readonly string[] {
  const full = [...path, name];
  const value = requireKey(table, name, file, path);
  if (!Array.isArray(value)) throw fail(file, full, "must be an array of strings");
  const items: unknown[] = value;
  return items.map((item) => {
    if (typeof item !== "string") throw fail(file, full, "must be an array of strings");
    if (item.trim() === "") throw fail(file, full, "must not contain empty strings");
    return item;
  });
}

export function readRepo(table: Table, name: string, file: string, path: KeyPath): string {
  const value = readString(table, name, file, path);
  if (!REPO_PATTERN.test(value)) throw fail(file, [...path, name], "must have the form owner/name");
  return value;
}

/** A table of string to non-empty string; any key name is allowed. */
export function readStringMap(table: Table, name: string, file: string, path: KeyPath): Readonly<Record<string, string>> {
  const section = requireTable(table, name, file, path);
  return readStringMapTable(section, file, [...path, name]);
}

export function readStringMapTable(section: Table, file: string, path: KeyPath): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(section)) {
    if (typeof value !== "string") throw fail(file, [...path, key], "must be a string");
    if (value.trim() === "") throw fail(file, [...path, key], "must not be empty");
    result[key] = value;
  }
  return result;
}
