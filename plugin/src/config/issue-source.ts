import type { LinearProject, ProjectConfig } from "../types/config.ts";
import type { SourceName } from "../types/sources.ts";

export function isLinearProject(project: ProjectConfig): project is LinearProject {
  return project.issueSource.kind === "linear";
}

/** Linear state names that pause an issue; empty for a project without Linear. */
export function pausedStatesOf(project: Pick<ProjectConfig, "issueSource">): readonly string[] {
  return project.issueSource.kind === "linear" ? project.issueSource.pausedStates : [];
}

/** Key in `SourceStatuses` of the project's issue source; null when the project fetches no issues. */
export function issueSourceStatusKey(project: Pick<ProjectConfig, "issueSource">): SourceName | null {
  return project.issueSource.kind === "linear" ? "linear" : null;
}

/** Whether the project's issue source can mark an issue as paused. */
export function canPauseIssues(project: Pick<ProjectConfig, "issueSource">): boolean {
  return pausedStatesOf(project).length > 0;
}
