import { SUPPORTED_PROTOCOL_VERSION } from "../sources/pohunek.ts";
import { host as parseControlHost, InvalidControlResponse } from "../control/decode.ts";
import { exec, execInteractive, SpawnError, type Exec, type InteractiveExec } from "../util/exec.ts";

export interface SessionLaunchConfig {
  readonly bin: string;
  readonly queryTimeoutMs: number;
  readonly launchTimeoutMs: number;
  readonly launchKillMarginMs: number;
}

export interface HostChoice { readonly id: string; readonly label: string }
export interface ProjectChoice { readonly id: string; readonly label: string }
export interface AgentChoice { readonly id: string; readonly label: string; readonly assistantCapable: boolean }
export interface ActionChoice { readonly id: string; readonly label: string; readonly template: string }
export interface ResolvedAction {
  readonly agent: string;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly prompt: string;
}
export interface LaunchOptions {
  readonly hosts: readonly HostChoice[];
  readonly projects: readonly ProjectChoice[];
  readonly agents: readonly AgentChoice[];
  readonly warning: string | null;
}

interface CommonRequest {
  readonly host: string;
  readonly project: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
}

export type LaunchRequest =
  | (CommonRequest & {
      readonly kind: "session";
      /** Null selects the core CLI's shell default. */
      readonly agent: string | null;
      readonly name: string | null;
      readonly prompt: string | null;
      readonly cols?: number;
      readonly rows?: number;
    })
  | (CommonRequest & {
      readonly kind: "assistant";
      readonly intent: "setup" | "project" | "update" | "debug" | "help";
      /** Null lets the core assistant choose a capable runtime. */
      readonly agent: string | null;
      /** Non-empty text is refused until the core CLI accepts private stdin input. */
      readonly request: string | null;
      readonly noSnapshot: boolean;
      readonly degraded: boolean;
    });

export interface CreatedSession {
  readonly sessionId: string;
  readonly host: string;
  readonly kind: LaunchRequest["kind"];
  readonly warnings: readonly string[];
}

export type LaunchStatus =
  | { readonly phase: "ready" }
  | { readonly phase: "creating" }
  | { readonly phase: "created"; readonly session: CreatedSession }
  | { readonly phase: "unknown"; readonly error: string };

export interface AttachResult {
  readonly sessionId: string;
  readonly host: string;
  /** Null when a signal ended the attach process. */
  readonly exitCode: number | null;
}

export type LaunchErrorCode = "invalid_request" | "cli_unavailable" | "cli_failed" | "invalid_response" | "creation_unknown" | "not_created" | "attach_failed";

export class LaunchError extends Error {
  public constructor(public readonly code: LaunchErrorCode, message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

export interface SessionLauncher {
  /** Reloads projects and runtimes whenever the selected host changes. */
  loadOptions(host?: string): Promise<LaunchOptions>;
  /** Lists provider-free templates on the selected project's host. */
  loadActions(host: string, project: string): Promise<readonly ActionChoice[]>;
  /** Resolves a template to editable launch defaults. */
  resolveAction(host: string, project: string, action: string): Promise<ResolvedAction>;
  /** At most one create attempt is made for this launcher instance. */
  createSession(request: LaunchRequest): Promise<CreatedSession>;
  /** Can be retried after an attach failure without creating another session. */
  attachSession(): Promise<AttachResult>;
  status(): LaunchStatus;
}

export interface SessionLauncherDeps {
  readonly exec?: Exec;
  readonly execInteractive?: InteractiveExec;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchError("invalid_response", `${path} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LaunchError("invalid_response", `${path} must be a non-empty string`);
  }
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new LaunchError("invalid_response", `${path} must be an array`);
  return value;
}

function envelope(stdout: string, exitCode: number | null): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new LaunchError("invalid_response", "pohunek returned invalid JSON");
  }
  const root = object(parsed, "$");
  requiredString(root["cli_version"], "$.cli_version");
  const protocol = object(root["protocol"], "$.protocol");
  const minimum = protocol["minimum"];
  const maximum = protocol["maximum"];
  if (typeof minimum !== "number" || typeof maximum !== "number") {
    throw new LaunchError("invalid_response", "pohunek returned an invalid protocol range");
  }
  if (SUPPORTED_PROTOCOL_VERSION < minimum || SUPPORTED_PROTOCOL_VERSION > maximum) {
    throw new LaunchError("cli_failed", `pohunek protocol ${String(minimum)}-${String(maximum)} does not support ${String(SUPPORTED_PROTOCOL_VERSION)}`);
  }
  if (("ok" in root) === ("err" in root)) {
    throw new LaunchError("invalid_response", "pohunek response must contain exactly one of ok and err");
  }
  if ("err" in root) {
    const code = requiredString(object(root["err"], "$.err")["code"], "$.err.code");
    if (code === "request_timeout") {
      throw new LaunchError("creation_unknown", `pohunek reported ${code}; the session may already exist`);
    }
    throw new LaunchError("cli_failed", `pohunek rejected the request (${code})`);
  }
  if (exitCode !== 0) throw new LaunchError("invalid_response", `pohunek reported success but exited with ${String(exitCode)}`);
  return root["ok"];
}

function hostChoices(payload: unknown): HostChoice[] {
  const choices: HostChoice[] = [{ id: "local", label: "Local" }];
  const seen = new Set(["local"]);
  for (const [index, raw] of array(payload, "$.ok").entries()) {
    const host = object(raw, `$.ok[${String(index)}]`);
    if (host["classification"] !== "reachable_daemon") continue;
    try {
      const decoded = parseControlHost(raw, `$.ok[${String(index)}]`);
      if (!decoded.dialable || seen.has(decoded.route)) continue;
      seen.add(decoded.route);
      choices.push({ id: decoded.route, label: decoded.name });
    } catch (error) {
      if (!(error instanceof InvalidControlResponse)) throw error;
      // A discoverable name without a dialable identity cannot launch a session.
    }
  }
  return choices;
}

function projectChoices(payload: unknown): ProjectChoice[] {
  return array(payload, "$.ok").map((raw, index) => {
    const project = object(raw, `$.ok[${String(index)}]`);
    return { id: requiredString(project["id"], `$.ok[${String(index)}].id`), label: requiredString(project["label"], `$.ok[${String(index)}].label`) };
  });
}

function agentChoices(payload: unknown): AgentChoice[] {
  const capabilities = object(payload, "$.ok");
  const seen = new Set<string>();
  const choices: AgentChoice[] = [];
  for (const [index, raw] of array(capabilities["runtimes"], "$.ok.runtimes").entries()) {
    const runtime = object(raw, `$.ok.runtimes[${String(index)}]`);
    const id = requiredString(runtime["agent"], `$.ok.runtimes[${String(index)}].agent`);
    if (runtime["available"] !== true || runtime["supported"] === false || seen.has(id)) continue;
    seen.add(id);
    const base = runtime["agent_base"];
    choices.push({ id, label: id, assistantCapable: typeof base === "string" && base !== "shell" });
  }
  return choices;
}

function actionChoices(payload: unknown): ActionChoice[] {
  const result = object(payload, "$.ok");
  return array(result["actions"], "$.ok.actions").flatMap((raw, index) => {
    const action = object(raw, `$.ok.actions[${String(index)}]`);
    if (action["provider"] !== "none") return [];
    const id = requiredString(action["name"], `$.ok.actions[${String(index)}].name`);
    return [{ id, label: id, template: requiredString(action["template"], `$.ok.actions[${String(index)}].template`) }];
  });
}

function optionalString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new LaunchError("invalid_response", `${path} must be a string`);
  return value;
}

function resolvedAction(payload: unknown): ResolvedAction {
  const action = object(payload, "$.ok");
  if (action["provider"] !== "none") {
    throw new LaunchError("invalid_request", "this action needs a provider item and cannot be launched from the new-session form");
  }
  const prompt = optionalString(action["prompt_content"], "$.ok.prompt_content");
  if (prompt === null) throw new LaunchError("invalid_response", "$.ok.prompt_content must be a string");
  // A provider-free action has no context for named ${variables}; match core's static renderer.
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(prompt)) {
    throw new LaunchError("invalid_request", "the selected template needs provider variables and cannot start a blank session");
  }
  return {
    agent: requiredString(action["agent"], "$.ok.agent"),
    branch: optionalString(action["branch"], "$.ok.branch"),
    baseBranch: optionalString(action["base_branch"], "$.ok.base_branch"),
    prompt,
  };
}

function optionalArg(argv: string[], flag: string, value: string | null): void {
  if (value !== null && value.trim() !== "") argv.push(flag, value);
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validate(request: LaunchRequest): void {
  if (request.host.trim() === "" || hasControl(request.host)) {
    throw new LaunchError("invalid_request", "host must be a non-empty name without control characters");
  }
  if (request.host !== "local" && (request.project === null || request.project.trim() === "")) {
    throw new LaunchError("invalid_request", "a remote launch needs a project");
  }
  if (request.baseBranch !== null && request.baseBranch.trim() !== "" && (request.branch === null || request.branch.trim() === "")) {
    throw new LaunchError("invalid_request", "base branch needs a branch");
  }
  if (request.branch !== null && request.project === null) {
    throw new LaunchError("invalid_request", "a branch needs a project");
  }
  if (request.kind === "session") {
    for (const [label, size] of [["cols", request.cols], ["rows", request.rows]] as const) {
      if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 65535)) {
        throw new LaunchError("invalid_request", `${label} must be between 1 and 65535`);
      }
    }
  } else {
    if (request.degraded && request.host !== "local") {
      throw new LaunchError("invalid_request", "degraded assistant launch is local only");
    }
    if (request.request !== null && request.request.trim() !== "") {
      throw new LaunchError("invalid_request", "assistant request text cannot be passed privately by the core CLI; launch without a request and type it after attaching");
    }
  }
}

function createArgv(bin: string, request: LaunchRequest, launchTimeoutMs: number): { argv: string[]; stdin: string } {
  const common: string[] = ["--host", request.host];
  optionalArg(common, "--project", request.project);
  optionalArg(common, "--branch", request.branch);
  optionalArg(common, "--base-branch", request.baseBranch);
  if (request.host !== "local") common.push("--yes");
  if (request.kind === "session") {
    const argv = [bin, "session", "new", ...common];
    optionalArg(argv, "--agent", request.agent);
    optionalArg(argv, "--name", request.name);
    if (request.cols !== undefined) argv.push("--cols", String(request.cols));
    if (request.rows !== undefined) argv.push("--rows", String(request.rows));
    const prompt = request.prompt?.trim() ?? "";
    if (prompt !== "") argv.push("--input-stdin");
    argv.push("--request-timeout-ms", String(launchTimeoutMs), "--json");
    return { argv, stdin: prompt === "" ? "" : request.prompt ?? "" };
  }
  const argv = [bin, "assistant", ...common, "--intent", request.intent];
  optionalArg(argv, "--agent", request.agent);
  if (request.noSnapshot) argv.push("--no-snapshot");
  if (request.degraded) argv.push("--degraded");
  argv.push("--json");
  return { argv, stdin: "" };
}

function sessionId(payload: unknown, kind: LaunchRequest["kind"]): string {
  const result = object(payload, "$.ok");
  const session = kind === "assistant" ? object(result["session"], "$.ok.session") : result;
  const id = requiredString(session["id"], kind === "assistant" ? "$.ok.session.id" : "$.ok.id");
  if (id.includes("/") || /\s/.test(id) || hasControl(id)) {
    throw new LaunchError("invalid_response", "pohunek returned an invalid session ID");
  }
  return id;
}

export function createSessionLauncher(config: SessionLaunchConfig, deps: SessionLauncherDeps = {}): SessionLauncher {
  const run = deps.exec ?? exec;
  const runInteractive = deps.execInteractive ?? execInteractive;
  let current: LaunchStatus = { phase: "ready" };
  let creating: Promise<CreatedSession> | null = null;
  let attaching: Promise<AttachResult> | null = null;

  async function query(args: readonly string[]): Promise<unknown> {
    let result;
    try {
      result = await run([config.bin, ...args, "--json"], { timeoutMs: config.queryTimeoutMs });
    } catch (error) {
      if (error instanceof SpawnError) throw new LaunchError("cli_unavailable", `cannot start ${config.bin}`);
      throw error;
    }
    if (result.timedOut) throw new LaunchError("cli_failed", `${args[0]} ${args[1]} timed out`);
    return envelope(result.stdout, result.exitCode);
  }

  async function loadOptions(host = "local"): Promise<LaunchOptions> {
    const outcomes = await Promise.allSettled([
      query(["host", "list"]),
      query(["project", "list", "--host", host]),
      query(["host", "inspect", host]),
    ]);
    const warnings: string[] = [];
    const read = (index: number, label: string): unknown => {
      const outcome = outcomes[index];
      if (outcome?.status === "fulfilled") return outcome.value;
      const reason: unknown = outcome?.status === "rejected" ? outcome.reason : null;
      warnings.push(`${label}: ${reason instanceof Error ? reason.message : "unavailable"}`);
      return null;
    };
    const hosts = read(0, "host list");
    const projects = read(1, "project list");
    const agents = read(2, "host inspect");
    return {
      hosts: hosts === null ? [{ id: "local", label: "Local" }] : hostChoices(hosts),
      projects: projects === null ? [] : projectChoices(projects),
      agents: agents === null ? [] : agentChoices(agents),
      warning: warnings.length === 0 ? null : warnings.join("; "),
    };
  }

  async function loadActions(host: string, project: string): Promise<readonly ActionChoice[]> {
    if (host.trim() === "" || project.trim() === "" || hasControl(host) || hasControl(project)) {
      throw new LaunchError("invalid_request", "host and project are required to list actions");
    }
    return actionChoices(await query(["project", "actions", "--host", host, project]));
  }

  async function resolveAction(host: string, project: string, action: string): Promise<ResolvedAction> {
    if (host.trim() === "" || project.trim() === "" || action.trim() === "" || [host, project, action].some(hasControl)) {
      throw new LaunchError("invalid_request", "host, project, and action are required to resolve a template");
    }
    return resolvedAction(await query(["project", "action", "--host", host, project, action]));
  }

  async function createSession(request: LaunchRequest): Promise<CreatedSession> {
    if (current.phase === "created") return current.session;
    if (current.phase === "unknown") throw new LaunchError("creation_unknown", current.error);
    if (creating !== null) return creating;
    validate(request);
    current = { phase: "creating" };
    creating = (async () => {
      const { argv, stdin } = createArgv(config.bin, request, config.launchTimeoutMs);
      let result;
      try {
        result = await run(argv, { timeoutMs: config.launchTimeoutMs + config.launchKillMarginMs, stdin });
      } catch (error) {
        if (error instanceof SpawnError) {
          current = { phase: "ready" };
          throw new LaunchError("cli_unavailable", `cannot start ${config.bin}`);
        }
        current = { phase: "unknown", error: "creation outcome unknown after a process error; inspect pohunek session list before trying again" };
        throw new LaunchError("creation_unknown", current.error);
      }
      if (result.timedOut || result.exitCode === null) {
        current = { phase: "unknown", error: "creation outcome unknown after a timeout or signal; inspect pohunek session list before trying again" };
        throw new LaunchError("creation_unknown", current.error);
      }
      let payload: unknown;
      try {
        payload = envelope(result.stdout, result.exitCode);
      } catch (error) {
        if (error instanceof LaunchError && error.code === "cli_failed") {
          current = { phase: "ready" };
          throw error;
        }
        const detail = error instanceof Error ? error.message : "unknown response";
        current = { phase: "unknown", error: `creation outcome unknown (${detail}); inspect pohunek session list before trying again` };
        throw new LaunchError("creation_unknown", current.error);
      }
      let id: string;
      try {
        id = sessionId(payload, request.kind);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "invalid session ID";
        current = { phase: "unknown", error: `creation outcome unknown (${detail}); inspect pohunek session list before trying again` };
        throw new LaunchError("creation_unknown", current.error);
      }
      const session: CreatedSession = { sessionId: id, host: request.host, kind: request.kind, warnings: [] };
      current = { phase: "created", session };
      return session;
    })().finally(() => { creating = null; });
    return creating;
  }

  async function attachSession(): Promise<AttachResult> {
    if (current.phase !== "created") throw new LaunchError("not_created", "create a session before attaching");
    if (attaching !== null) return attaching;
    const session = current.session;
    attaching = (async () => {
      try {
        const exitCode = await runInteractive([config.bin, "attach", "--host", session.host, session.sessionId]);
        return { sessionId: session.sessionId, host: session.host, exitCode };
      } catch (error) {
        if (error instanceof SpawnError) throw new LaunchError("attach_failed", `cannot start ${config.bin}; session ${session.sessionId} already exists on ${session.host}`);
        throw error;
      }
    })().finally(() => { attaching = null; });
    return attaching;
  }

  return { loadOptions, loadActions, resolveAction, createSession, attachSession, status: () => current };
}
