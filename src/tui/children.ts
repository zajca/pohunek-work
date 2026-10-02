// Child processes of the TUI. `list` runs piped with a timeout through
// util/exec.ts (own process group, killed whole on timeout).
import { SpawnError, type Exec } from "../util/exec.ts";
import type { Argv } from "./actions.ts";
import { decodeListEnvelope, type ListOutcome } from "./decode.ts";
import type { ChildRun } from "./model.ts";

export interface ListRun {
  readonly run: ChildRun;
  readonly outcome: ListOutcome | null;
  readonly durationMs: number;
}

function stderrLines(stderr: string): string[] {
  return stderr.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
}

/** Exit 3 (partial data) still carries a full envelope on stdout, so stdout is decoded whatever the exit code. */
export async function runList(exec: Exec, argv: Argv, timeoutMs: number, now: () => number): Promise<ListRun> {
  const started = now();
  try {
    const result = await exec(argv, { timeoutMs });
    const run: ChildRun = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      spawnError: null,
      stderr: stderrLines(result.stderr),
    };
    const outcome = result.timedOut || result.stdout.trim() === "" ? null : decodeListEnvelope(result.stdout);
    return { run, outcome, durationMs: now() - started };
  } catch (error) {
    if (!(error instanceof SpawnError)) throw error;
    return {
      run: { exitCode: null, timedOut: false, spawnError: `cannot start ${error.binary}`, stderr: [] },
      outcome: null,
      durationMs: now() - started,
    };
  }
}
