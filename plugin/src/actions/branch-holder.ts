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
import { gatherEvidence, SESSION_ID, staleEvidenceReason, validTarget, type CleanupCheck, type EvidenceDeps } from "./cleanup.ts";
import { ActionError } from "./types.ts";

/** A worktree that has a branch checked out. */
export interface BranchHolder {
  readonly path: string;
  readonly branch: string;
  /** Session that owns the worktree; null when none does (the primary checkout, a worktree made by hand). */
  readonly sessionId: string | null;
}

/** The options of the launch that decide which row a `pohunek-work do <key> ...` command resolves. */
export interface RowScope {
  /** `--project` as given; null when the launch did not pass it. */
  readonly project: string | null;
  readonly includeIgnored: boolean;
}

export interface HolderContext {
  readonly row: CollectedRow;
  readonly scope: RowScope;
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

/**
 * Normalizes before quoting: `toAscii` folds compatibility characters (a fullwidth quote or
 * backslash becomes an ASCII one), which after the JSON escaping would forge a field.
 */
function quoted(text: string, limit: number): string {
  const folded = text.normalize("NFKD");
  const bounded = folded.length > limit ? `${folded.slice(0, limit)}${ELLIPSIS}` : folded;
  return toAscii(JSON.stringify(bounded));
}

const SAFE_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** One shell word for a command shown to the owner; null when it cannot be shown faithfully. */
function shellWord(value: string): string | null {
  if (value.length === 0 || !PRINTABLE_ASCII.test(value)) return null;
  return SAFE_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** `pohunek-work do <key> <verb>` with the options that make it resolve the row the launch resolved. */
function doCommand(row: CollectedRow, scope: RowScope, verb: string): string | null {
  const words = [row.listItem.key, verb, ...(scope.project === null ? [] : ["--project", scope.project]), ...(scope.includeIgnored ? ["--include-ignored"] : [])].map((w) =>
    w.startsWith("--") ? w : shellWord(w),
  );
  return words.includes(null) ? null : `pohunek-work do ${words.join(" ")}`;
}

function attachCommand(row: CollectedRow, scope: RowScope, session: PohunekSession): string | null {
  const liveLinked = row.item.sessions.filter(isLiveSession);
  const [only] = liveLinked;
  if (only !== undefined && liveLinked.length === 1 && only.id === session.id) {
    const linked = doCommand(row, scope, "attach");
    if (linked !== null) return linked;
  }
  return SESSION_ID.test(session.id) ? `pohunek attach ${session.id}` : null;
}

/** How to continue with live sessions: attach to them instead of starting another one. */
export function attachAdvice(row: CollectedRow, scope: RowScope, live: readonly PohunekSession[]): string {
  const commands = live.flatMap((session) => {
    const command = attachCommand(row, scope, session);
    return command === null ? [] : [`\`${command}\``];
  });
  return commands.length > 0 ? `attach with ${commands.join(" or ")}` : "inspect it with `pohunek session list`";
}

/** The one linked session that owns a worktree is the one `do <key> cleanup` acts on. */
function releaseCommand(row: CollectedRow, scope: RowScope, session: PohunekSession): { command: string; revalidates: boolean } {
  const owners = row.item.sessions.filter((s) => s.worktreePath !== null);
  const [only] = owners;
  if (only !== undefined && owners.length === 1 && only.id === session.id) {
    const linked = doCommand(row, scope, "cleanup");
    if (linked !== null) return { command: linked, revalidates: true };
  }
  return { command: `pohunek session rm ${session.id}`, revalidates: false };
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
  const none = (failures: readonly Failure[]): { failures: readonly Failure[]; dirty: readonly string[]; ignored: number } => ({ failures, dirty: [], ignored: 0 });
  try {
    const target = validTarget(session, ctx.row.project.pohunekLabel);
    if (target.worktreePath !== holder.path || target.branch !== holder.branch) {
      return { failures: [{ name: "holder_session", detail: "the worktree or branch of the session differs from the one holding the branch" }], dirty: [], ignored: 0 };
    }
    const evidence = await gatherEvidence(session, target, ctx.sessions, ctx.config, ctx.deps);
    const failing: CleanupCheck[] = evidence.checks.filter((c) => !c.ok);
    if (failing.length === 0) {
      // The evidence took several reads; a writer may have started meanwhile. Any change or unreadable list is a refusal.
      const listed = await ctx.deps.pohunek.listSessions();
      if (!listed.ok) return none([{ name: "evidence_stale", detail: `the session list could not be re-read (${listed.code})` }]);
      const expected = { sessionId: session.id, worktreePath: target.worktreePath, branch: target.branch, project: target.project };
      const stale = staleEvidenceReason(listed.data.find((s) => s.id === session.id), listed.data, expected, evidence);
      if (stale !== null) return none([{ name: "evidence_stale", detail: stale }]);
    }
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
  if (isLiveSession(session)) return `${by}; the session is live: ${attachAdvice(row, ctx.scope, [session])}`;

  const { failures, dirty, ignored } = await releaseEvidence(holder, session, ctx);
  if (failures.length > 0) return refusalText(by, failures, dirty, config);
  const { command, revalidates } = releaseCommand(row, ctx.scope, session);
  const caution = revalidates
    ? "`cleanup` checks everything again before it removes anything."
    : "`pohunek session rm` force-removes the worktree and does not recheck anything: run `pohunek session list` immediately before and release only if the session is still finished.";
  return (
    `${by}; when this was read the session was finished, its worktree clean and in sync with ${config.global.actions.cleanupRemote}, and every other cleanup check passed, ` +
    `so it can be released with \`${command}\` (${String(ignored)} ignored entries are lost with the worktree). ${caution} ` +
    "`do` itself removes nothing."
  );
}
