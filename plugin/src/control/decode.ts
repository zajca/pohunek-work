import type {
  ControlGovernance, ControlHost, ControlHostCapabilities, ControlNotification, ControlProject, ControlProjectDetail,
  ControlScreen, ControlSession,
} from "./types.ts";

export class InvalidControlResponse extends Error {}
type Json = Record<string, unknown>;

function invalid(path: string, expected: string): never {
  throw new InvalidControlResponse(`${path}: expected ${expected}`);
}
export function object(value: unknown, path: string): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Json : invalid(path, "an object");
}
export function array(value: unknown, path: string): readonly unknown[] {
  return Array.isArray(value) ? value as readonly unknown[] : invalid(path, "an array");
}
export function string(obj: Json, key: string, path: string): string {
  return typeof obj[key] === "string" ? obj[key] : invalid(`${path}.${key}`, "a string");
}
export function nullableString(obj: Json, key: string, path: string): string | null {
  const value = obj[key];
  return value === undefined || value === null ? null : typeof value === "string" ? value : invalid(`${path}.${key}`, "a string");
}
export function boolean(obj: Json, key: string, path: string): boolean {
  return typeof obj[key] === "boolean" ? obj[key] : invalid(`${path}.${key}`, "a boolean");
}
export function number(obj: Json, key: string, path: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : invalid(`${path}.${key}`, "a number");
}
export function count(obj: Json, key: string, path: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid(`${path}.${key}`, "a non-negative integer");
}
function optionalObject(obj: Json, key: string, path: string): Json | null {
  const value = obj[key];
  return value === undefined || value === null ? null : object(value, `${path}.${key}`);
}
function optionalArray(obj: Json, key: string, path: string): readonly unknown[] {
  const value = obj[key];
  return value === undefined || value === null ? [] : array(value, `${path}.${key}`);
}
function stringArray(value: unknown, path: string): readonly string[] {
  return array(value, path).map((entry, index) => typeof entry === "string" ? entry : invalid(`${path}[${String(index)}]`, "a string"));
}

export function host(raw: unknown, path: string): ControlHost {
  const obj = object(raw, path);
  const classification = string(obj, "classification", path);
  if (!["reachable_daemon", "version_mismatch", "unreachable", "candidate"].includes(classification)) {
    invalid(`${path}.classification`, "a known host classification");
  }
  const overlay = string(obj, "overlay", path);
  const peerId = nullableString(obj, "peer_id", path);
  const fqdn = nullableString(obj, "fqdn", path);
  const address = nullableString(obj, "address", path);
  const name = nullableString(obj, "name", path) ?? fqdn ?? address ?? "Unknown host";
  const port = count(obj, "port", path);
  if (port < 1 || port > 65535 || !/^[a-z][a-z0-9_-]*$/i.test(overlay)) {
    invalid(path, "a valid overlay route and port");
  }
  const identity = peerId === null || peerId === "" ? fqdn : peerId;
  const identityKind = peerId === null || peerId === "" ? "fqdn" : "peer";
  if ((identity === null || identity === "") && classification === "reachable_daemon") {
    invalid(path, "a peer id or fqdn");
  }
  const dialable = identity !== null && identity !== "";
  const selector = Buffer.from(identity || `${overlay}:${name}:${address ?? ""}:${String(port)}`).toString("base64url");
  return {
    route: dialable ? `${overlay}:${identityKind}~${selector}@${String(port)}` : `undialable:${selector}`,
    dialable,
    name,
    classification: classification as ControlHost["classification"],
    daemonVersion: nullableString(obj, "daemon_version", path),
    address,
  };
}

export function session(raw: unknown, path: string, hostRoute: string): ControlSession {
  const obj = object(raw, path);
  const runtime = optionalObject(obj, "runtime", path);
  const caps = optionalObject(obj, "capabilities", path);
  const metadata: Record<string, string> = {};
  const rawMetadata = optionalObject(obj, "metadata", path);
  if (rawMetadata !== null) {
    for (const [key, value] of Object.entries(rawMetadata)) {
      metadata[key] = typeof value === "string" ? value : invalid(`${path}.metadata.${key}`, "a string");
    }
  }
  const subagents = optionalArray(obj, "subagents", path).map((rawAgent, index) => {
    const at = `${path}.subagents[${String(index)}]`;
    const agent = object(rawAgent, at);
    const finished = agent["finished_at_ms"];
    return {
      id: string(agent, "id", at), parentId: nullableString(agent, "parent_id", at),
      provider: string(agent, "provider", at), agentType: nullableString(agent, "agent_type", at),
      lifecycle: string(agent, "lifecycle", at), activity: nullableString(agent, "activity", at),
      startedAtMs: count(agent, "started_at_ms", at), updatedAtMs: count(agent, "updated_at_ms", at),
      finishedAtMs: finished === undefined || finished === null ? null : count(agent, "finished_at_ms", at),
    };
  });
  return {
    host: hostRoute,
    id: string(obj, "id", path), name: nullableString(obj, "name", path),
    agent: string(obj, "agent", path), cwd: string(obj, "cwd", path),
    state: string(obj, "state", path), activity: nullableString(obj, "activity", path),
    runtimeState: runtime === null ? null : nullableString(runtime, "state", `${path}.runtime`),
    updatedAt: string(obj, "updated_at", path),
    projectId: nullableString(obj, "project_id", path), projectLabel: nullableString(obj, "project_label", path),
    branch: nullableString(obj, "branch", path), worktreePath: nullableString(obj, "worktree_path", path),
    external: obj["external"] === undefined || obj["external"] === null ? false : boolean(obj, "external", path),
    canResume: caps === null ? false : boolean(caps, "resume", `${path}.capabilities`),
    canFork: caps === null ? false : boolean(caps, "fork", `${path}.capabilities`),
    metadata, subagents, subagentCount: subagents.length,
  };
}

export function project(raw: unknown, path: string, hostRoute: string): ControlProject {
  const obj = object(raw, path);
  return {
    host: hostRoute, id: string(obj, "id", path), label: string(obj, "label", path),
    repoRoot: string(obj, "repo_root", path), originUrl: nullableString(obj, "origin_url", path),
    defaultBaseBranch: nullableString(obj, "default_base_branch", path),
  };
}
export function projectDetail(raw: unknown, path: string, hostRoute: string): ControlProjectDetail {
  const obj = object(raw, path);
  return {
    project: project(obj["project"], `${path}.project`, hostRoute),
    worktrees: array(obj["worktrees"], `${path}.worktrees`).map((entry, index) => {
      const at = `${path}.worktrees[${String(index)}]`;
      const tree = object(entry, at);
      return { path: string(tree, "path", at), branch: nullableString(tree, "branch", at),
        head: nullableString(tree, "head", at), sessionId: nullableString(tree, "session_id", at) };
    }),
  };
}
export function notification(raw: unknown, path: string, hostRoute: string): ControlNotification {
  const obj = object(raw, path);
  const status = string(obj, "status", path);
  if (!["unread", "read", "acknowledged", "archived", "deleted"].includes(status)) {
    invalid(`${path}.status`, "a known notification status");
  }
  return {
    host: hostRoute, id: string(obj, "id", path), kind: string(obj, "kind", path),
    severity: string(obj, "severity", path), status: status as ControlNotification["status"],
    title: string(obj, "title", path), body: string(obj, "body", path), createdAt: string(obj, "created_at", path),
    sessionId: nullableString(obj, "session_id", path), projectId: nullableString(obj, "project_id", path),
  };
}
export function capabilities(raw: unknown, path: string): ControlHostCapabilities {
  const obj = object(raw, path);
  return {
    daemonVersion: string(obj, "daemon_version", path), protocolVersion: number(obj, "protocol_version", path),
    supportedAgents: stringArray(obj["supported_agents"], `${path}.supported_agents`),
    gitAvailable: boolean(obj, "git_available", path), worktreeSupported: boolean(obj, "worktree_supported", path),
    terminalReadSupported: boolean(obj, "terminal_read_supported", path),
    outputReadSupported: boolean(obj, "output_read_supported", path),
  };
}
export function governance(raw: unknown, path: string): ControlGovernance {
  const obj = object(raw, path);
  const enrollment = optionalObject(obj, "enrollment", path);
  const owner = optionalObject(obj, "owner", path);
  const ownerKind = owner === null ? null : string(owner, "kind", `${path}.owner`);
  if (ownerKind !== null && ownerKind !== "principal" && ownerKind !== "team") {
    invalid(`${path}.owner.kind`, "principal or team");
  }
  const ownerRevision = obj["owner_revision"];
  return {
    hostId: string(obj, "host_id", path),
    enrollment: enrollment === null ? null : {
      relayId: string(enrollment, "relay_id", `${path}.enrollment`),
      status: string(enrollment, "status", `${path}.enrollment`),
      revision: count(enrollment, "revision", `${path}.enrollment`),
    },
    owner: owner === null ? null : { kind: ownerKind as "principal" | "team", id: string(owner, "id", `${path}.owner`) },
    ownerRevision: ownerRevision === undefined || ownerRevision === null ? null : count(obj, "owner_revision", path),
    quarantine: nullableString(obj, "quarantine", path),
    approvalKeyReference: string(obj, "approval_key_reference", path),
  };
}
export function screen(raw: unknown, path: string): ControlScreen {
  const obj = object(raw, path);
  return { sessionId: string(obj, "session_id", path), title: nullableString(obj, "title", path),
    progress: nullableString(obj, "progress", path), visibleLines: stringArray(obj["visible_lines"], `${path}.visible_lines`) };
}
