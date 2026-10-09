import type { ListPayload } from "../types/item.ts";
import { SpawnError, exec } from "../util/exec.ts";
import { decodeDoEnvelope, decodeListEnvelope, type DoOutcome } from "../tui/decode.ts";
import { attachArgv, previewArgv, writeArgv, type ArgvResult } from "../tui/actions.ts";

export interface WorkSnapshot {
  readonly payload: ListPayload | null;
  readonly warning: string | null;
  readonly partial: boolean;
}

export async function loadWork(selfBin: string, timeoutMs: number): Promise<WorkSnapshot> {
  try {
    const run = await exec([selfBin, "list", "--json"], { timeoutMs });
    if (run.timedOut) return { payload: null, warning: "Work list timed out", partial: false };
    if (run.stdout.trim() === "") return { payload: null, warning: run.stderr.trim() || "Work list returned no data", partial: false };
    const outcome = decodeListEnvelope(run.stdout);
    if (outcome.kind === "ok") {
      return { payload: outcome.payload, warning: run.stderr.trim() || null, partial: run.exitCode === 3 };
    }
    return {
      payload: null,
      warning: outcome.kind === "error" ? `${outcome.err.code}: ${outcome.err.msg}` : outcome.message,
      partial: false,
    };
  } catch (error) {
    if (error instanceof SpawnError) return { payload: null, warning: error.message, partial: false };
    throw error;
  }
}

export async function previewWork(selfBin: string, timeoutMs: number, key: string, action: string, project: string): Promise<DoOutcome | string> {
  const checked = previewArgv(selfBin, key, action, project);
  if (!checked.ok) return checked.reason;
  try {
    const run = await exec(checked.argv, { timeoutMs });
    if (run.timedOut) return "Action preview timed out";
    if (run.stdout.trim() === "") return run.stderr.trim() || "Action preview returned no data";
    return decodeDoEnvelope(run.stdout);
  } catch (error) {
    if (error instanceof SpawnError) return error.message;
    throw error;
  }
}

export function workActionArgv(selfBin: string, key: string, action: string, project: string): ArgvResult {
  return action === "attach" ? attachArgv(selfBin, key, project) : writeArgv(selfBin, key, action, project);
}
