import type { ControlSession } from "../control/types.ts";
import type { ListItem } from "../types/item.ts";
import { githubBranchUrl } from "../tui/actions.ts";
import type { WorkSnapshot } from "./work.ts";

/** One line of a session's Links block: the label shown and the URL it opens. */
export interface SessionLink {
  readonly label: string;
  readonly url: string;
}

/** The work item a session is linked to, from the metadata the plugin and the launch flows write. */
export function workLinkOf(session: ControlSession): string | null {
  return session.metadata["work.link.id"] !== undefined ? session.metadata["work.link.url"] ?? null : session.metadata["link.url"] ?? null;
}

/**
 * Every known link of a session in display order: the pull request and the issue of its Work item, the core
 * work link, and the branch page on GitHub. Equal URLs are shown once, under the first label.
 * `list --json` reads the local daemon only, so the Work join is matched on local sessions alone. The branch
 * page is left out when the project's origin is not a GitHub repository, since the repository is never guessed.
 */
export function sessionLinks(session: ControlSession, items: readonly ListItem[] | null, originUrl: string | null): SessionLink[] {
  const candidates: SessionLink[] = [];
  for (const item of joinedItems(session, items)) {
    if (item.pull_request !== null) candidates.push({ label: "GitHub PR", url: item.pull_request.url });
    const issue = issueOf(item, items ?? []);
    if (issue !== null) candidates.push({ label: issue.id.startsWith("linear:") ? "Linear issue" : "GitHub issue", url: issue.url });
  }
  const core = workLinkOf(session);
  if (core !== null) candidates.push({ label: labelOfUrl(core), url: core });
  const branch = githubBranchUrl(originUrl, session.branch);
  if (branch !== null) candidates.push({ label: "Branch on GitHub", url: branch });
  const seen = new Set<string>();
  return candidates.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

/** Longest warning of the Work source shown in a reason; the rest of a longer first line is cut. */
const WARNING_REASON_MAX = 120;

/**
 * Why a session has no link in its Links block, one reason per missing source. Work links exist for local sessions
 * only and come from the loaded Work list: a list that is missing, failed, or incomplete (a source did not answer,
 * or the last good rows are kept after a failed refresh) cannot say that nothing matches. The branch page needs the
 * project's GitHub origin.
 */
export function noLinkReason(session: ControlSession, work: WorkSnapshot | null, originUrl: string | null): string {
  const reasons: string[] = [];
  // The branch page is named first: the Links block cuts a long line at the panel width, and this cause is the rarer one.
  if (session.branch !== null && session.branch !== "" && githubBranchUrl(originUrl, session.branch) === null) {
    reasons.push(originUrl === null ? "no origin: no branch page" : "origin is not GitHub: no branch page");
  }
  if (session.host !== "local") reasons.push("Work is read on the local host only");
  else if (work === null || work.payload === null) reasons.push(work?.warning ? `Work unavailable: ${warningText(work.warning)}` : "Work not loaded yet");
  else if (work.partial || work.warning !== null) reasons.push(`Work incomplete: ${work.warning === null ? "a source did not answer" : warningText(work.warning)}`);
  else reasons.push("no Work match for this session");
  return reasons.join("; ");
}

/** The first line of a Work warning, cut to WARNING_REASON_MAX characters. */
function warningText(warning: string): string {
  const line = warning.split("\n")[0]?.trim() ?? "";
  return line.length > WARNING_REASON_MAX ? `${line.slice(0, WARNING_REASON_MAX - 1)}…` : line;
}

/**
 * The issue of a joined item. Several pull requests can share one issue: the Work list then carries the issue on one
 * of their rows only, and the others name it by `issue_key`, so the issue is taken from the row that carries it.
 */
function issueOf(item: ListItem, items: readonly ListItem[]): ListItem["issue"] {
  if (item.issue !== null || item.issue_key === null) return item.issue;
  const carrier = items.find((other) => other.project === item.project && other.issue_key === item.issue_key && other.issue !== null);
  return carrier?.issue ?? null;
}

function joinedItems(session: ControlSession, items: readonly ListItem[] | null): readonly ListItem[] {
  if (items === null || session.host !== "local") return [];
  return items.filter((item) => item.sessions.some((linked) => linked.id === session.id));
}

/** Label of a core work link, read from its URL; a URL of another kind is labelled generically. */
function labelOfUrl(url: string): string {
  if (/^https:\/\/linear\.app\//.test(url)) return "Linear issue";
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\//.test(url)) return "GitHub PR";
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\//.test(url)) return "GitHub issue";
  return "Work link";
}
