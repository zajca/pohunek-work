// Stand-in work source for the TUI scenarios. The daemon fixture cannot reach GitHub or Linear, so a scenario that
// needs a Work answer (a joined pull request, an incomplete source, a list that changes between refreshes) runs
// this script in place of `list --json`. Each call prints the envelope of the current phase and exits with the
// phase's code, the way the real command does for a failed or incomplete source.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_WORK_LIST, LIST_ARGV_FILE, PROJECT } from "./scenario.ts";

/** A work item of the `list --json` envelope joined to one local session. */
export function workItem(sessionId: string, key: string, pullRequestUrl: string | null, issue: { id: string; url: string } | null): Record<string, unknown> {
  return {
    key,
    project: PROJECT,
    issue: issue === null ? null : { id: issue.id, title: "Links check", state: "started", url: issue.url },
    pull_request: pullRequestUrl === null ? null : { id: "12", url: pullRequestUrl, title: "Links check", draft: false, updated_at: "2026-10-14T10:00:00Z", review_decision: null, checks: "success", mergeable: "mergeable", fix_delivered: null, threads_answered: null, rerequested: null },
    no_issue: issue === null,
    issue_key: issue === null ? null : issue.id,
    sessions: [{ id: sessionId, name: "links", role: null, state: "running", activity: "working", indicator: "running", updated_at: null }],
    on_turn: { actor: "me", reason: "review", rule: null },
    actions: [],
    ignored: false,
    sources: { github: "ok", github_merged: "ok", linear: "ok", github_issues: "ok", pohunek: "ok" },
  };
}

/** The `list --json` envelope of the given items, in the shape the work source prints. */
export function workList(items: readonly Record<string, unknown>[]): unknown {
  const envelope = structuredClone(EMPTY_WORK_LIST);
  return { ...envelope, ok: { ...envelope.ok, items } };
}

/** One phase of the stand-in: whether it prints the envelope of its file, its stderr and its exit code. */
export interface WorkPhase { readonly envelope: boolean; readonly stderr: string; readonly exit: number }

/** Work-list calls answered with the `before` phase; later calls get the `after` phase. */
export const SWITCH_AFTER_CALLS = 8;
/** The work refresh runs once a second in the scenarios that change the answer while the TUI runs. */
export const REFRESH_SECS = 1;

/**
 * Writes the stand-in script into `dir` and returns its path. The envelopes are read from `dir/work-before.json` and
 * `dir/work-after.json` at each call, so a test can write them once its session exists; the calls are counted in
 * `dir/list-calls`, and each call is recorded as `cached` or `refresh` in `dir/list-argv`, the mode the TUI asked for.
 */
export async function scriptedWorkSource(dir: string, before: WorkPhase, after: WorkPhase, switchAfter: number): Promise<string> {
  const path = join(dir, "work-source-scripted");
  const callsFile = join(dir, "list-calls");
  const argvFile = join(dir, LIST_ARGV_FILE);
  const phaseOf = (phase: WorkPhase, name: "before" | "after"): unknown => ({ ...phase, file: phase.envelope ? join(dir, `work-${name}.json`) : null });
  await writeFile(path, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const refresh = args.join(" ") === "list --refresh --json";
if (refresh || args.join(" ") === "list --json") {
  appendFileSync(${JSON.stringify(callsFile)}, "list\\n");
  appendFileSync(${JSON.stringify(argvFile)}, (refresh ? "refresh" : "cached") + "\\n");
  const calls = readFileSync(${JSON.stringify(callsFile)}, "utf8").split("\\n").length - 1;
  const phase = calls <= ${String(switchAfter)} ? ${JSON.stringify(phaseOf(before, "before"))} : ${JSON.stringify(phaseOf(after, "after"))};
  if (phase.file !== null) process.stdout.write(readFileSync(phase.file, "utf8") + "\\n");
  if (phase.stderr !== "") process.stderr.write(phase.stderr + "\\n");
  process.exit(phase.exit);
} else process.exit(70);
`);
  await chmod(path, 0o700);
  return path;
}

/** Writes the envelope of one phase into the scenario directory; `name` is `before` or `after`. */
export async function writeWorkPhase(dir: string, name: "before" | "after", envelope: unknown): Promise<void> {
  await writeFile(join(dir, `work-${name}.json`), JSON.stringify(envelope));
}
