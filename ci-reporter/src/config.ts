export const CORE_REPOSITORY = "zajca/pohunek";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const ISSUE_LABEL = "red-main-incident";
export const REPORTER_JOB_NAME = "red-main-report";

export interface TrackedMacosJob {
  readonly key: string;
  readonly name: string;
}

export const TRACKED_MACOS_JOBS: readonly TrackedMacosJob[] = [
  {
    key: "platform-contracts-arm64",
    name: "platform contracts (arm64)",
  },
  {
    key: "macos-package-macos-14",
    name: "macOS package install and upgrade (macos-14)",
  },
  {
    key: "macos-package-macos-15",
    name: "macOS package install and upgrade (macos-15)",
  },
  {
    key: "hermes-compatibility-macos-arm64",
    name: "pinned Hermes compatibility (macOS arm64, model-free)",
  },
  {
    key: "sdk-workspace-macos-arm64",
    name: "SDK workspace (macOS arm64)",
  },
];

export function jobLabel(job: TrackedMacosJob): string {
  return `red-main-${job.key}`;
}

export function findTrackedJob(name: string): TrackedMacosJob | undefined {
  return TRACKED_MACOS_JOBS.find((job) => job.name === name);
}
