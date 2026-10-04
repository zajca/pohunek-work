// Row keys of issue rows: `linear:<KEY>` for a Linear project and
// `github-issue:<owner/name>#<n>` for a project whose issues come from GitHub.

import type { ProjectConfig } from "../types/config.ts";

const LINEAR_PREFIX = "linear:";
const GITHUB_ISSUE_PREFIX = "github-issue:";

/** The key of the row that holds `issueKey` in `project`. */
export function issueRowKey(project: Pick<ProjectConfig, "issueSource">, issueKey: string): string {
  return `${project.issueSource.kind === "linear" ? LINEAR_PREFIX : GITHUB_ISSUE_PREFIX}${issueKey}`;
}

/** Whether `rowKey` is the issue row of `issueKey`, in whichever project kind; the contract carries no project kind. */
export function isIssueRowOf(rowKey: string, issueKey: string): boolean {
  return rowKey === `${LINEAR_PREFIX}${issueKey}` || rowKey === `${GITHUB_ISSUE_PREFIX}${issueKey}`;
}

export function isGithubIssueRowKey(rowKey: string): boolean {
  return rowKey.startsWith(GITHUB_ISSUE_PREFIX);
}
