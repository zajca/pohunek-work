// JSON-lines command log. Secret hygiene is enforced here, not left to callers:
// secret-looking keys are redacted at any depth, Errors are reduced to
// name and message, and unserializable values never throw.
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { SourceResult } from "./types/sources.ts";

export type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };

/** Like LogValue, but Error objects are accepted and logged as `{name, message}` only. */
export type LogInput = string | number | boolean | null | Error | LogInput[] | { [key: string]: LogInput };

export type LogFields = Readonly<Record<string, LogInput>>;

export interface LoggerOptions {
  readonly logDir: string;
  readonly command: string;
  readonly maxStringLength: number;
  readonly now?: () => Date;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  sourceResult(result: SourceResult<unknown>): void;
  /** First I/O error met while writing, or null when every write succeeded. */
  failure(): Error | null;
  /** Resolves once all queued writes have settled; never rejects. */
  close(): Promise<void>;
}

export const REDACTED = "[redacted]";
export const TRUNCATION_MARKER = "...[truncated]";
export const CIRCULAR_MARKER = "[circular]";
export const UNSERIALIZABLE_MARKER = "[unserializable]";

const SECRET_KEY = /token|secret|authorization|password|credential|api[_-]?key/i;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

type Level = "info" | "error";

function sanitize(value: unknown, maxStringLength: number, ancestors: object[]): LogValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return value.length > maxStringLength ? value.slice(0, maxStringLength) + TRUNCATION_MARKER : value;
    case "number":
      return Number.isFinite(value) ? value : UNSERIALIZABLE_MARKER;
    case "boolean":
      return value;
    case "object":
      break;
    default:
      // bigint, symbol, function
      return UNSERIALIZABLE_MARKER;
  }

  const obj = value;
  if (ancestors.includes(obj)) return CIRCULAR_MARKER;
  if (obj instanceof Error) {
    return {
      name: sanitize(obj.name, maxStringLength, ancestors),
      message: sanitize(obj.message, maxStringLength, ancestors),
    };
  }

  ancestors.push(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item: unknown) => sanitize(item, maxStringLength, ancestors));
    }
    const out: { [key: string]: LogValue } = {};
    for (const [key, item] of Object.entries(obj)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : sanitize(item, maxStringLength, ancestors);
    }
    return out;
  } finally {
    ancestors.pop();
  }
}

function safeSanitize(value: unknown, maxStringLength: number): LogValue {
  try {
    return sanitize(value, maxStringLength, []);
  } catch {
    // A throwing getter or a stack overflow on pathological nesting must not escape the logger.
    return UNSERIALIZABLE_MARKER;
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const { logDir, command, maxStringLength } = options;
  const now = options.now ?? ((): Date => new Date());
  if (!COMMAND_NAME.test(command)) {
    throw new Error(`Invalid log command name: ${JSON.stringify(command)}`);
  }
  if (!Number.isInteger(maxStringLength) || maxStringLength < 1) {
    throw new Error("maxStringLength must be a positive integer");
  }

  const file = join(logDir, `${command}.log`);
  let firstFailure: Error | null = null;
  let queue: Promise<void> = Promise.resolve();
  let prepared = false;

  async function write(line: string): Promise<void> {
    if (!prepared) {
      await mkdir(logDir, { recursive: true, mode: DIR_MODE });
      await chmod(logDir, DIR_MODE);
    }
    await appendFile(file, line, { mode: FILE_MODE });
    if (!prepared) {
      await chmod(file, FILE_MODE);
      prepared = true;
    }
  }

  function record(level: Level, event: string, fields: LogFields | undefined): void {
    // Each field is sanitized on its own so one hostile value cannot hide the others.
    const extra: { [key: string]: LogValue } = {};
    for (const [key, item] of Object.entries(fields ?? {})) {
      extra[key] = SECRET_KEY.test(key) ? REDACTED : safeSanitize(item, maxStringLength);
    }
    // Reserved keys come last so fields cannot override them.
    const entry = {
      ...extra,
      ts: now().toISOString(),
      level,
      command,
      event: safeSanitize(event, maxStringLength),
    };
    const line = JSON.stringify(entry) + "\n";
    queue = queue.then(() => write(line)).catch((error: unknown) => {
      firstFailure ??= error instanceof Error ? error : new Error(String(error));
    });
  }

  return {
    info: (event, fields) => {
      record("info", event, fields);
    },
    error: (event, fields) => {
      record("error", event, fields);
    },
    sourceResult: (result) => {
      if (result.ok) {
        record("info", "source_result", { source: result.source, ok: true, durationMs: result.durationMs });
      } else {
        record("error", "source_result", {
          source: result.source,
          ok: false,
          durationMs: result.durationMs,
          code: result.code,
          message: result.message,
        });
      }
    },
    failure: () => firstFailure,
    close: () => queue,
  };
}
