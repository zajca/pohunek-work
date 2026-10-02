// What the TUI may run: a fixed action allowlist, key and project shape checks
// and the argv of every child. `do` stays the authority and can still refuse;
// these checks keep anything unexpected out of argv in the first place.

/** Actions the TUI executes. `merge` is not one of them, whatever a contract lists. */
export const TUI_ACTIONS = ["implement", "babysit", "fix-ci", "rebase", "review", "ready", "attach"] as const;

export type TuiAction = (typeof TUI_ACTIONS)[number];

export function isTuiAction(name: string): name is TuiAction {
  return TUI_ACTIONS.some((action) => action === name);
}

/** `linear:<TEAM>-<n>` or `github:<owner>/<name>#<n>`; never starts with `-`. */
const KEY_SHAPE = /^(linear:[A-Z][A-Z0-9]*-[0-9]+|github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+)$/;
/** A pohunek project label; never starts with `-`. */
const PROJECT_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type Argv = readonly string[];

export type ArgvResult = { readonly ok: true; readonly argv: Argv } | { readonly ok: false; readonly reason: string };

function target(action: string, key: string, project: string): string | null {
  if (!isTuiAction(action)) return `action ${action} is not supported by the TUI`;
  if (!KEY_SHAPE.test(key)) return "the row key has an unexpected shape; not passed to do";
  if (!PROJECT_SHAPE.test(project)) return "the row project has an unexpected shape; not passed to do";
  return null;
}

export function listArgv(selfBin: string): Argv {
  return [selfBin, "list", "--json"];
}

/** `do --dry-run --json`: read-only, piped. */
export function previewArgv(selfBin: string, key: string, action: string, project: string): ArgvResult {
  const refused = target(action, key, project);
  if (refused !== null) return { ok: false, reason: refused };
  return { ok: true, argv: [selfBin, "do", key, action, "--project", project, "--dry-run", "--json"] };
}

/** A write: `do` shows the plan and asks y/N itself on the handed-over terminal. */
export function writeArgv(selfBin: string, key: string, action: string, project: string): ArgvResult {
  const refused = target(action, key, project);
  if (refused !== null) return { ok: false, reason: refused };
  if (action === "attach") return { ok: false, reason: "attach is not a write" };
  return { ok: true, argv: [selfBin, "do", key, action, "--project", project, "--json"] };
}

/** `do attach` takes no `--json` outside a dry run; it reports by exit code. */
export function attachArgv(selfBin: string, key: string, project: string): ArgvResult {
  const refused = target("attach", key, project);
  if (refused !== null) return { ok: false, reason: refused };
  return { ok: true, argv: [selfBin, "do", key, "attach", "--project", project] };
}

export type OpenUrlResult = { readonly ok: true; readonly href: string; readonly host: string } | { readonly ok: false; readonly reason: string };

/** Only `https:` URLs without credentials whose host is exactly in the allowlist. */
export function checkOpenUrl(url: string, hosts: readonly string[]): OpenUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "the URL does not parse" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "only https URLs are opened" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "URLs with credentials are not opened" };
  if (parsed.port !== "") return { ok: false, reason: "URLs with an explicit port are not opened" };
  if (!hosts.includes(parsed.hostname)) return { ok: false, reason: `host ${parsed.hostname} is not in open_url_hosts` };
  return { ok: true, href: parsed.href, host: parsed.hostname };
}
