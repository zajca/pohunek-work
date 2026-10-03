// Secret Service lookup through `secret-tool`. The secret exists only in the
// object returned by readKeyringSecret; messages never contain it or tool output.

import type { LinearConfig } from "../types/config.ts";
import { exec as defaultExec, type Exec } from "../util/exec.ts";

export type KeyringFailureKind = "not_found" | "locked" | "unavailable";

export type KeyringReadResult =
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: false; readonly kind: KeyringFailureKind; readonly message: string };

export interface KeyringPresence {
  readonly present: boolean;
  readonly kind?: KeyringFailureKind;
}

export interface KeyringDeps {
  readonly exec?: Exec;
}

const LOCKED_PATTERN = /locked|unlock/i;

function failure(kind: KeyringFailureKind, message: string): KeyringReadResult {
  return { ok: false, kind, message };
}

export async function readKeyringSecret(
  config: LinearConfig,
  deps: KeyringDeps = {},
): Promise<KeyringReadResult> {
  const run = deps.exec ?? defaultExec;
  const argv = [
    config.secretToolBin,
    "lookup",
    "service",
    config.keyringService,
    "username",
    config.keyringKey,
  ];
  let result: Awaited<ReturnType<Exec>>;
  try {
    result = await run(argv, { timeoutMs: config.timeoutMs });
  } catch {
    return failure("unavailable", "secret-tool could not be started");
  }
  if (result.timedOut) {
    return failure("unavailable", "secret-tool lookup timed out");
  }
  if (result.exitCode !== 0) {
    if (LOCKED_PATTERN.test(result.stderr)) {
      return failure("locked", "keyring is locked");
    }
    if (result.exitCode === 1 && result.stdout === "") {
      return failure("not_found", "keyring entry not found");
    }
    return failure("unavailable", "secret-tool lookup failed");
  }
  const secret = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (secret === "") {
    return failure("not_found", "keyring entry not found");
  }
  return { ok: true, secret };
}

/** Reports whether the entry exists and is non-empty; the value is discarded. */
export async function keyringEntryPresent(
  config: LinearConfig,
  deps: KeyringDeps = {},
): Promise<KeyringPresence> {
  const result = await readKeyringSecret(config, deps);
  return result.ok ? { present: true } : { present: false, kind: result.kind };
}
