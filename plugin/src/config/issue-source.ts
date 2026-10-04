import type { GithubProject, LinearProject, ProjectConfig } from "../types/config.ts";
import type { SourceName } from "../types/sources.ts";

export function isLinearProject(project: ProjectConfig): project is LinearProject {
  return project.issueSource.kind === "linear";
}

export function isGithubProject(project: ProjectConfig): project is GithubProject {
  return project.issueSource.kind === "github";
}

/** Key in `SourceStatuses` of the project's issue source. */
export function issueSourceStatusKey(project: Pick<ProjectConfig, "issueSource">): SourceName {
  return project.issueSource.kind === "linear" ? "linear" : "github_issues";
}

/** Whether the project's issue source can mark an issue as paused: it has paused states or paused labels. */
export function canPauseIssues(project: Pick<ProjectConfig, "issueSource">): boolean {
  const { issueSource } = project;
  return (issueSource.kind === "linear" ? issueSource.pausedStates : issueSource.pausedLabels).length > 0;
}
