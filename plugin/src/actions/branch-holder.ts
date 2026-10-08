// Diagnosis of the holder of a branch `do` needs: the text a collision refusal carries.
// `do` never frees anything. A release is offered only when the checks of `cleanup` pass
// on fresh evidence, so "safe to release" means exactly "`cleanup` would accept it";
// anything unreadable or failing is refused without a removal command. Strings that come
// from git or pohunek (paths, session ids, check details) reach the text only
// JSON-quoted, ASCII-only and length-bounded.
import type { CollectedRow } from "../commands/list.ts";
import { isLiveSession } from "../sources/pohunek.ts";
import type { PluginConfig } from "../types/config.ts";
import type { PohunekSession } from "../types/sources.ts";
import { toAscii } from "../output/sanitize.ts";
import { gatherEvidence, SESSION_ID, validTarget, type CleanupCheck, type EvidenceDeps } from "./cleanup.ts";
import { ActionError } from "./types.ts";

/** A worktree that has a branch checked out. */
export interface BranchHolder {
  readonly path: string;
  readonly branch: string;
  /** Session that owns the worktree; null when none does (the primary checkout, a worktree made by hand). */
  readonly sessionId: string | null;
}

export interface HolderContext {
  readonly row: CollectedRow;
  /** Every session pohunek knows, linked or not. */
  readonly sessions: readonly PohunekSession[];
  readonly config: PluginConfig;
  readonly deps: EvidenceDeps;
}

interface Failure {
  readonly name: string;
  readonly detail: string;
}

const ELLIPSIS = "...";

function quoted(text: string, limit: number): string {
  const bounded = text.length > limit ? `${text.slice(0, limit)}${ELLIPSIS}` : text;
  return toAscii(JSON.stringify(bounded));
}

function attachCommand(row: CollectedRow, session: PohunekSession): string | null {
  const liveLinked = row.item.sessions.filter(isLiveSession);
  const [only] = liveLinked;
  if (only !== undefined && liveLinked.length === 1 && only.id === session.id) return `pohunek-work do ${row.listItem.key} attach`;
  return SESSION_ID.test(session.id) ? `pohunek attach ${session.id}` : null;
}

/** How to continue with live sessions: attach to them instead of starting another one. */
export function attachAdvice(row: CollectedRow, live: readonly PohunekSession[]): string {
  const commands = live.flatMap((session) => {
    const command = attachCommand(row, session);
    return command === null ? [] : [`\`${command}\``];
  });
  return commands.length > 0 ? `attach with ${commands.join(" or ")}` : "inspect it with `pohunek session list`";
}

/** The one linked session that owns a worktree is the one `do <key> cleanup` acts on. */
function releaseCommand(row: CollectedRow, session: PohunekSession): string {
  const owners = row.item.sessions.filter((s) => s.worktreePath !== null);
  const [only] = owners;
  return only !== undefined && owners.length === 1 && only.id === session.id
    ? `pohunek-work do ${row.listItem.key} cleanup`
    : `pohunek session rm ${session.id}`;
}

function listEntries(entries: readonly string[], config: PluginConfig): string {
  const { holderEntriesListed: listed, holderEntryMaxLength: limit } = config.global.actions;
  const shown = entries.slice(0, listed).map((entry) => quoted(entry, limit));
  const more = entries.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${String(more)} more` : shown.join(", ");
}

function refusalText(by: string, failures: readonly Failure[], dirty: readonly string[], config: PluginConfig): string {
  const limit = config.global.actions.holderEntryMaxLength;
  const checks = failures.map((f) => `${f.name} (${quoted(f.detail, limit)})`).join(", ");
  const entries = dirty.length > 0 ? ` Uncommitted or untracked entries: ${listEntries(dirty, config)}.` : "";
  return (
    `${by}; it cannot be released safely, failed checks: ${checks}.${entries} ` +
    "No removal command is offered: commit and push or clean the worktree by hand, then retry."
  );
}

/** Evidence of the `cleanup` checks for the holder, or the reasons it could not be read. */
async function releaseEvidence(
  holder: BranchHolder,
  session: PohunekSession,
  ctx: HolderContext,
): Promise<{ failures: readonly Failure[]; dirty: readonly string[]; ignored: number }> {
  try {
    const target = validTarget(session, ctx.row.project.pohunekLabel);
    if (target.worktreePath !== holder.path || target.branch !== holder.branch) {
      return { failures: [{ name: "holder_session", detail: "the worktree or branch of the session differs from the one holding the branch" }], dirty: [], ignored: 0 };
    }
    const evidence = await gatherEvidence(session, target, ctx.sessions, ctx.config, ctx.deps);
    const failing: CleanupCheck[] = evidence.checks.filter((c) => !c.ok);
    return { failures: failing.map((c) => ({ name: c.name, detail: c.detail })), dirty: evidence.inventory.dirty, ignored: evidence.inventory.ignored.length };
  } catch (error) {
    if (error instanceof ActionError) return { failures: [{ name: "holder_session", detail: error.message }], dirty: [], ignored: 0 };
    return { failures: [{ name: "evidence", detail: "the evidence could not be gathered" }], dirty: [], ignored: 0 };
  }
}

/**
 * What the owner can do about `holder`, as the text that follows `<action> refused: `. Read-only:
 * it names the holder and offers attach, a release the `cleanup` checks accept, or neither.
 */
export async function diagnoseBranchHolder(holder: BranchHolder, ctx: HolderContext): Promise<string> {
  const { config, row } = ctx;
  const limit = config.global.actions.holderEntryMaxLength;
  const where = `${quoted(holder.branch, limit)} is already checked out in ${quoted(holder.path, limit)}`;
  if (holder.sessionId === null) {
    return (
      `${where}, which no pohunek session owns (the project's primary checkout or a worktree made by hand); ` +
      "switch that checkout to another branch yourself, then retry. It is never offered for release."
    );
  }
  const session = ctx.sessions.find((s) => s.id === holder.sessionId);
  if (session === undefined) {
    const by = `${where} by session ${quoted(holder.sessionId, limit)} (not listed by pohunek)`;
    return refusalText(by, [{ name: "holder_session", detail: "pohunek does not list the session that owns the worktree" }], [], config);
  }

  const by = `${where} by session ${quoted(session.id, limit)} (${quoted(session.state, limit)})`;
  if (isLiveSession(session)) return `${by}; the session is live: ${attachAdvice(row, [session])}`;

  const { failures, dirty, ignored } = await releaseEvidence(holder, session, ctx);
  if (failures.length > 0) return refusalText(by, failures, dirty, config);
  return (
    `${by}; the session is finished, its worktree is clean and in sync with ${config.global.actions.cleanupRemote}, and every other cleanup check passes, ` +
    `so it is safe to release with \`${releaseCommand(row, session)}\` (${String(ignored)} ignored entries are lost with the worktree). ` +
    "`do` itself removes nothing."
  );
}
