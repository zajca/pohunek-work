// Runtime checks of the `list --json` and `do --json` envelopes a child printed.
// The TUI trusts no shape it has not checked here; an envelope whose protocol
// range excludes the version this build speaks is refused, never guessed.
import { DO_CONTRACT_VERSION } from "../actions/types.ts";
import {
  LIST_CONTRACT_VERSION,
  type ListAction,
  type ListError,
  type ListIssue,
  type ListItem,
  type ListOnTurn,
  type ListPayload,
  type ListProjectStatus,
  type ListPullRequest,
  type ListSession,
  type OrphanedSession,
  type RuleNumber,
  type SourceStatuses,
  type TurnActor,
  type UnlinkedSession,
} from "../types/item.ts";

class ShapeError extends Error {}

type Fields = Readonly<Record<string, unknown>>;

function object(value: unknown, path: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ShapeError(`${path} is not an object`);
  return value as Fields;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ShapeError(`${path} is not a string`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ShapeError(`${path} is not a boolean`);
  return value;
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  return value === null ? null : boolean(value, path);
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ShapeError(`${path} is not an integer`);
  return value;
}

function array<T>(value: unknown, path: string, item: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new ShapeError(`${path} is not an array`);
  const entries: unknown[] = value;
  return entries.map((entry, index) => item(entry, `${path}[${index.toString()}]`));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const text = string(value, path);
  const match = allowed.find((option) => option === text);
  if (match === undefined) throw new ShapeError(`${path} has an unknown value`);
  return match;
}

const ACTORS: readonly TurnActor[] = ["me", "agent", "reviewer", "paused", "unknown"];
const CHECKS: readonly ListPullRequest["checks"][] = ["success", "failure", "pending", "none"];
const MAX_RULE = 13;

function rule(value: unknown, path: string): RuleNumber | null {
  if (value === null) return null;
  const number = integer(value, path);
  if (number < 1 || number > MAX_RULE) throw new ShapeError(`${path} is not a known rule`);
  return number as RuleNumber;
}

function sources(value: unknown, path: string): SourceStatuses {
  const fields = object(value, path);
  return {
    github: string(fields["github"], `${path}.github`),
    github_merged: string(fields["github_merged"], `${path}.github_merged`),
    linear: string(fields["linear"], `${path}.linear`),
    pohunek: string(fields["pohunek"], `${path}.pohunek`),
  } as SourceStatuses;
}

function issue(value: unknown, path: string): ListIssue | null {
  if (value === null) return null;
  const fields = object(value, path);
  return {
    id: string(fields["id"], `${path}.id`),
    title: string(fields["title"], `${path}.title`),
    state: string(fields["state"], `${path}.state`),
    url: string(fields["url"], `${path}.url`),
  };
}

function pullRequest(value: unknown, path: string): ListPullRequest | null {
  if (value === null) return null;
  const fields = object(value, path);
  return {
    id: string(fields["id"], `${path}.id`),
    url: string(fields["url"], `${path}.url`),
    title: string(fields["title"], `${path}.title`),
    draft: boolean(fields["draft"], `${path}.draft`),
    updated_at: string(fields["updated_at"], `${path}.updated_at`),
    review_decision: nullableString(fields["review_decision"], `${path}.review_decision`) as ListPullRequest["review_decision"],
    checks: oneOf(fields["checks"], CHECKS, `${path}.checks`),
    mergeable: string(fields["mergeable"], `${path}.mergeable`) as ListPullRequest["mergeable"],
    fix_delivered: nullableBoolean(fields["fix_delivered"], `${path}.fix_delivered`),
    threads_answered: nullableBoolean(fields["threads_answered"], `${path}.threads_answered`),
    rerequested: nullableBoolean(fields["rerequested"], `${path}.rerequested`),
  };
}

function session(value: unknown, path: string): ListSession {
  const fields = object(value, path);
  return {
    id: string(fields["id"], `${path}.id`),
    name: nullableString(fields["name"], `${path}.name`),
    role: nullableString(fields["role"], `${path}.role`),
    state: string(fields["state"], `${path}.state`),
    activity: nullableString(fields["activity"], `${path}.activity`),
  };
}

function action(value: unknown, path: string): ListAction {
  const fields = object(value, path);
  const base = { name: string(fields["name"], `${path}.name`), delegable: boolean(fields["delegable"], `${path}.delegable`) };
  return fields["profile"] === undefined ? base : { ...base, profile: string(fields["profile"], `${path}.profile`) };
}

function onTurn(value: unknown, path: string): ListOnTurn {
  const fields = object(value, path);
  return {
    actor: oneOf(fields["actor"], ACTORS, `${path}.actor`),
    reason: string(fields["reason"], `${path}.reason`),
    rule: rule(fields["rule"], `${path}.rule`),
  };
}

function item(value: unknown, path: string): ListItem {
  const fields = object(value, path);
  return {
    key: string(fields["key"], `${path}.key`),
    project: string(fields["project"], `${path}.project`),
    issue: issue(fields["issue"], `${path}.issue`),
    pull_request: pullRequest(fields["pull_request"], `${path}.pull_request`),
    no_issue: boolean(fields["no_issue"], `${path}.no_issue`),
    sessions: array(fields["sessions"], `${path}.sessions`, session),
    on_turn: onTurn(fields["on_turn"], `${path}.on_turn`),
    actions: array(fields["actions"], `${path}.actions`, action),
    sources: sources(fields["sources"], `${path}.sources`),
  };
}

function orphan(value: unknown, path: string): OrphanedSession {
  const fields = object(value, path);
  return {
    id: string(fields["id"], `${path}.id`),
    name: nullableString(fields["name"], `${path}.name`),
    linkId: string(fields["linkId"], `${path}.linkId`),
  };
}

function unlinked(value: unknown, path: string): UnlinkedSession {
  const fields = object(value, path);
  return {
    id: string(fields["id"], `${path}.id`),
    name: nullableString(fields["name"], `${path}.name`),
    project: string(fields["project"], `${path}.project`),
    state: string(fields["state"], `${path}.state`),
    activity: nullableString(fields["activity"], `${path}.activity`),
  };
}

function projectStatus(value: unknown, path: string): ListProjectStatus {
  const fields = object(value, path);
  return { project: string(fields["project"], `${path}.project`), sources: sources(fields["sources"], `${path}.sources`) };
}

function payload(value: unknown): ListPayload {
  const fields = object(value, "ok");
  return {
    items: array(fields["items"], "ok.items", item),
    orphaned_sessions: array(fields["orphaned_sessions"], "ok.orphaned_sessions", orphan),
    unlinked_sessions: array(fields["unlinked_sessions"], "ok.unlinked_sessions", unlinked),
    projects: array(fields["projects"], "ok.projects", projectStatus),
  };
}

function error(value: unknown): ListError {
  const fields = object(value, "err");
  const base = {
    class: string(fields["class"], "err.class"),
    code: string(fields["code"], "err.code"),
    msg: string(fields["msg"], "err.msg"),
  };
  return fields["recover"] === undefined ? base : { ...base, recover: string(fields["recover"], "err.recover") };
}

/** Common to both contracts: the envelope shape and the protocol range check. */
type Envelope =
  | { readonly kind: "ok"; readonly cliVersion: string; readonly ok: unknown }
  | { readonly kind: "error"; readonly cliVersion: string; readonly err: ListError }
  | { readonly kind: "incompatible"; readonly message: string }
  | { readonly kind: "malformed"; readonly message: string };

function envelope(stdout: string, version: number): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "malformed", message: stdout.trim() === "" ? "no output" : "output is not JSON" };
  }
  try {
    const fields = object(parsed, "envelope");
    const cliVersion = string(fields["cli_version"], "cli_version");
    const protocol = object(fields["protocol"], "protocol");
    const minimum = integer(protocol["minimum"], "protocol.minimum");
    const maximum = integer(protocol["maximum"], "protocol.maximum");
    if (version < minimum || version > maximum) {
      return {
        kind: "incompatible",
        message: `protocol ${minimum.toString()}-${maximum.toString()} does not include version ${version.toString()}`,
      };
    }
    if ("err" in fields) return { kind: "error", cliVersion, err: error(fields["err"]) };
    if (!("ok" in fields)) throw new ShapeError("envelope has neither ok nor err");
    return { kind: "ok", cliVersion, ok: fields["ok"] };
  } catch (failure) {
    if (failure instanceof ShapeError) return { kind: "malformed", message: failure.message };
    throw failure;
  }
}

export type ListOutcome =
  | { readonly kind: "ok"; readonly cliVersion: string; readonly payload: ListPayload }
  | { readonly kind: "error"; readonly cliVersion: string; readonly err: ListError }
  | { readonly kind: "incompatible"; readonly message: string }
  | { readonly kind: "malformed"; readonly message: string };

export function decodeListEnvelope(stdout: string): ListOutcome {
  const decoded = envelope(stdout, LIST_CONTRACT_VERSION);
  if (decoded.kind !== "ok") return decoded;
  try {
    return { kind: "ok", cliVersion: decoded.cliVersion, payload: payload(decoded.ok) };
  } catch (failure) {
    if (failure instanceof ShapeError) return { kind: "malformed", message: failure.message };
    throw failure;
  }
}

/** One labelled value of a `do` plan or result, in display order. */
export interface DoField {
  readonly label: string;
  readonly value: string;
}

export interface DoOk {
  readonly kind: "ok";
  readonly dryRun: boolean;
  readonly action: string;
  readonly key: string;
  readonly plan: readonly DoField[];
  /** Null for a dry run. */
  readonly result: readonly DoField[] | null;
}

export type DoOutcome =
  | DoOk
  | { readonly kind: "error"; readonly err: ListError }
  | { readonly kind: "incompatible"; readonly message: string }
  | { readonly kind: "malformed"; readonly message: string };

/** Plan fields of every action, in the order `do` prints them; absent ones are skipped. */
const PLAN_FIELDS = [
  "profile",
  "pull_request",
  "session_id",
  "branch",
  "base_branch",
  "expected_head",
  "cwd",
  "name",
  "argv",
  "verify_argv",
  "prompt",
] as const;

const RESULT_FIELDS = ["session_id", "name", "branch", "worktree_path", "pull_request", "is_draft", "warnings"] as const;

function displayValue(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return array(value, path, string).join(" ");
  throw new ShapeError(`${path} has an unexpected type`);
}

function fields(source: Fields, names: readonly string[], path: string): DoField[] {
  return names.flatMap((name) => {
    const value = displayValue(source[name], `${path}.${name}`);
    return value === null ? [] : [{ label: name, value }];
  });
}

export function decodeDoEnvelope(stdout: string): DoOutcome {
  const decoded = envelope(stdout, DO_CONTRACT_VERSION);
  if (decoded.kind === "error") return { kind: "error", err: decoded.err };
  if (decoded.kind !== "ok") return decoded;
  try {
    const ok = object(decoded.ok, "ok");
    const plan = object(ok["plan"], "ok.plan");
    const dryRun = boolean(ok["dry_run"], "ok.dry_run");
    const result = dryRun ? null : fields(object(ok["result"], "ok.result"), RESULT_FIELDS, "ok.result");
    return {
      kind: "ok",
      dryRun,
      action: string(plan["action"], "ok.plan.action"),
      key: string(plan["key"], "ok.plan.key"),
      plan: fields(plan, PLAN_FIELDS, "ok.plan"),
      result,
    };
  } catch (failure) {
    if (failure instanceof ShapeError) return { kind: "malformed", message: failure.message };
    throw failure;
  }
}
