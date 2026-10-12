// Experimental Beads queue for the manager. GitHub issues remain the work source;
// Beads contributes dependency ordering and an atomic claim within its workspace.
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { toAscii } from "../output/sanitize.ts";
import type { Exec } from "../util/exec.ts";
import { SpawnError } from "../util/exec.ts";

export const BEADS_CONTRACT_VERSION = 1;

export class BeadsUsageError extends Error {}

export class BeadsError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface BeadsOptions {
  readonly action: "ready" | "claim";
  readonly id: string | null;
  readonly workspace: string;
  readonly bin: string;
  readonly repoUrl: string;
  readonly project: string;
  readonly actor: string;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly json: boolean;
}

export interface BeadsItem {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly issue_key: string | null;
  readonly reason: "missing_external_ref" | "different_repo" | "invalid_external_ref" | null;
}

export type BeadsPayload =
  | { readonly action: "ready"; readonly items: readonly BeadsItem[] }
  | {
      readonly action: "claim";
      readonly id: string;
      readonly issue_key: string;
      readonly assignee: string | null;
      readonly claimed: boolean;
      readonly next_argv: readonly string[];
    };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_PATTERN = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;

export function parseBeadsArgs(argv: readonly string[]): BeadsOptions {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        workspace: { type: "string" },
        "bd-bin": { type: "string" },
        "repo-url": { type: "string" },
        project: { type: "string" },
        actor: { type: "string" },
        "timeout-ms": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const [action, id, ...extra] = positionals;
    if (action !== "ready" && action !== "claim") throw new BeadsUsageError("beads needs ready or claim");
    if (extra.length > 0 || (action === "ready" && id !== undefined) || (action === "claim" && (id === undefined || !ID_PATTERN.test(id)))) {
      throw new BeadsUsageError(action === "claim" ? "beads claim needs one valid Beads id" : "beads ready takes no id");
    }
    const workspace = values.workspace;
    const bin = values["bd-bin"];
    if (workspace === undefined || !isAbsolute(workspace)) throw new BeadsUsageError("--workspace needs an absolute directory");
    if (bin === undefined || !isAbsolute(bin)) throw new BeadsUsageError("--bd-bin needs an absolute executable path");
    const repoUrl = values["repo-url"];
    if (repoUrl === undefined) throw new BeadsUsageError("--repo-url is required");
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      throw new BeadsUsageError("--repo-url needs a GitHub repository URL");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || !REPO_PATTERN.test(parsed.pathname)) {
      throw new BeadsUsageError("--repo-url needs a canonical https://github.com/owner/repo URL");
    }
    const project = values.project;
    if (project === undefined || !ID_PATTERN.test(project)) throw new BeadsUsageError("--project needs a pohunek project label");
    const actor = values.actor;
    if (actor === undefined || !ID_PATTERN.test(actor)) throw new BeadsUsageError("--actor needs a manager identity");
    const timeout = values["timeout-ms"];
    if (timeout === undefined || !/^[1-9][0-9]*$/.test(timeout) || Number(timeout) > 2_147_483_647) {
      throw new BeadsUsageError("--timeout-ms needs a positive integer up to 2147483647");
    }
    if (values.yes && values["dry-run"]) throw new BeadsUsageError("--yes and --dry-run exclude each other");
    if (action === "ready" && (values.yes || values["dry-run"])) throw new BeadsUsageError("--yes and --dry-run apply to beads claim only");
    if (action === "claim" && !values.yes && !values["dry-run"]) throw new BeadsUsageError("beads claim needs --dry-run or --yes");
    return {
      action,
      id: id ?? null,
      workspace,
      bin,
      repoUrl: `https://github.com${parsed.pathname.replace(/\/$/, "")}`,
      project,
      actor,
      timeoutMs: Number(timeout),
      dryRun: values["dry-run"],
      yes: values.yes,
      json: values.json,
    };
  } catch (error) {
    if (error instanceof BeadsUsageError) throw error;
    throw new BeadsUsageError(error instanceof Error ? error.message : "invalid beads arguments");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function issueKey(ref: unknown, repoUrl: string): Pick<BeadsItem, "issue_key" | "reason"> {
  if (ref === undefined || ref === null || ref === "") return { issue_key: null, reason: "missing_external_ref" };
  if (typeof ref !== "string") return { issue_key: null, reason: "invalid_external_ref" };
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return { issue_key: null, reason: "invalid_external_ref" };
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return { issue_key: null, reason: "invalid_external_ref" };
  }
  const repo = new URL(repoUrl);
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/.exec(url.pathname);
  if (match === null) return { issue_key: null, reason: "invalid_external_ref" };
  const linkedRepo = `${match[1]}/${match[2]}`;
  const selectedRepo = repo.pathname.slice(1);
  if (linkedRepo.toLowerCase() !== selectedRepo.toLowerCase()) return { issue_key: null, reason: "different_repo" };
  return { issue_key: `github-issue:${selectedRepo}#${match[3]}`, reason: null };
}

function parseReady(stdout: string, repoUrl: string): BeadsItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new BeadsError("invalid_output", "bd ready did not return JSON");
  }
  if (!Array.isArray(raw)) throw new BeadsError("invalid_output", "bd ready did not return an array");
  return raw.map((value: unknown) => {
    const item = record(value);
    if (item === null || typeof item["id"] !== "string" || !ID_PATTERN.test(item["id"]) || typeof item["title"] !== "string" || !Number.isInteger(item["priority"]) || item["status"] !== "open") {
      throw new BeadsError("invalid_output", "bd ready returned an invalid issue");
    }
    return {
      id: item["id"],
      title: item["title"],
      priority: item["priority"] as number,
      ...issueKey(item["external_ref"], repoUrl),
    };
  });
}

async function bd(options: BeadsOptions, exec: Exec, args: readonly string[]): Promise<string> {
  let result;
  try {
    result = await exec([options.bin, "--actor", options.actor, ...args], { cwd: options.workspace, timeoutMs: options.timeoutMs });
  } catch (error) {
    if (error instanceof SpawnError) throw new BeadsError("unavailable", `cannot start bd at ${options.bin}`);
    throw error;
  }
  if (result.timedOut) throw new BeadsError("timed_out", `bd ${args[0]} timed out; the operation may have completed`);
  if (result.exitCode !== 0) throw new BeadsError("command_failed", `bd ${args[0]} failed: ${toAscii(result.stderr.trim())}`);
  return result.stdout;
}

export async function runBeads(options: BeadsOptions, exec: Exec): Promise<BeadsPayload> {
  const ready = parseReady(await bd(options, exec, ["ready", "--limit", "0", "--json"]), options.repoUrl);
  if (options.action === "ready") return { action: "ready", items: ready };
  const item = ready.find((candidate) => candidate.id === options.id);
  if (item === undefined) throw new BeadsError("not_ready", `Beads issue ${options.id} is not ready`);
  if (item.issue_key === null) throw new BeadsError("unlinked", `Beads issue ${item.id} has no canonical issue link for ${options.repoUrl}: ${item.reason}`);
  const nextArgv = ["pohunek-work", "do", item.issue_key, "implement", "--project", options.project, "--dry-run", "--json"];
  if (options.dryRun) return { action: "claim", id: item.id, issue_key: item.issue_key, assignee: null, claimed: false, next_argv: nextArgv };

  const output = await bd(options, exec, ["update", item.id, "--claim", "--json"]);
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new BeadsError("claim_unverified", `bd claimed ${item.id} but did not return JSON; inspect it before retrying`);
  }
  const claimed = Array.isArray(raw) && raw.length === 1 ? record(raw[0]) : null;
  if (claimed === null || claimed["id"] !== item.id || claimed["status"] !== "in_progress" || claimed["assignee"] !== options.actor || issueKey(claimed["external_ref"], options.repoUrl).issue_key !== item.issue_key) {
    throw new BeadsError("claim_unverified", `bd claim of ${item.id} returned an unexpected issue; inspect it before retrying`);
  }
  return { action: "claim", id: item.id, issue_key: item.issue_key, assignee: options.actor, claimed: true, next_argv: nextArgv };
}

export function renderBeads(payload: BeadsPayload): string {
  if (payload.action === "claim") {
    return `${payload.claimed ? "claimed" : "would claim"} ${payload.id} for ${payload.issue_key}\nnext: ${payload.next_argv.join(" ")}`;
  }
  return payload.items.map((item) => {
    const target = item.issue_key ?? `unlinked:${item.reason}`;
    return toAscii(`${item.id}  P${item.priority}  ${target}  ${item.title}`);
  }).join("\n");
}
