import type { LinearProject, ProjectConfig } from "../types/config.ts";

export function isLinearProject(project: ProjectConfig): project is LinearProject {
  return project.issueSource.kind === "linear";
}

/** Linear state names that pause an issue; empty for a project without Linear. */
export function pausedStatesOf(project: Pick<ProjectConfig, "issueSource">): readonly string[] {
  return project.issueSource.kind === "linear" ? project.issueSource.pausedStates : [];
}
