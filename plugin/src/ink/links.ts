import type { ControlSession } from "../control/types.ts";
import type { ListItem } from "../types/item.ts";
import { githubBranchUrl } from "../tui/actions.ts";

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
    if (item.issue !== null) candidates.push({ label: item.issue.id.startsWith("linear:") ? "Linear issue" : "GitHub issue", url: item.issue.url });
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
