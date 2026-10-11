import {
  CI_WORKFLOW_PATH,
  findTrackedJob,
  ISSUE_LABEL,
  jobLabel,
  REPORTER_JOB_NAME,
  TRACKED_MACOS_JOBS,
  type TrackedMacosJob,
} from "./config.ts";
import type { GithubApi, JsonObject } from "./github.ts";

interface WorkflowRun extends JsonObject {
  readonly id: number;
  readonly run_number: number;
  readonly run_attempt: number;
  readonly event: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly path: string;
  readonly html_url: string;
  readonly repository: { readonly full_name: string };
  readonly head_repository: { readonly full_name: string } | null;
}

interface JobStep extends JsonObject {
  readonly name: string;
  readonly conclusion: string | null;
}

interface WorkflowJob extends JsonObject {
  readonly id: number;
  readonly name: string;
  readonly run_id: number;
  readonly run_url: string;
  readonly html_url: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly steps: readonly JobStep[];
}

interface Issue extends JsonObject {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly labels: readonly { readonly name: string }[];
  readonly pull_request?: unknown;
}

interface IssueComment extends JsonObject {
  readonly body: string;
}

interface CompareResult extends JsonObject {
  readonly html_url: string;
  readonly total_commits: number;
}

interface IncidentMetadata {
  readonly jobKey: string;
  readonly runId: number;
  readonly runNumber: number;
  readonly runAttempt: number;
}

interface RunOrder {
  readonly runNumber: number;
  readonly attempt: number;
}

export interface ReporterOptions {
  readonly dryRun: boolean;
  readonly callerRunId: number;
  readonly callerRepository: string;
  readonly callerSha: string;
  readonly callerJobName: string;
}

export interface ReporterAction {
  readonly kind: "create" | "comment" | "close" | "dry-run" | "skip";
  readonly jobKey: string;
  readonly detail: string;
}

export interface ReporterResult {
  readonly actions: readonly ReporterAction[];
}

const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
const SUCCESS_CONCLUSION = "success";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export async function reportCoreRun(
  readApi: GithubApi,
  issueApi: GithubApi,
  repository: string,
  runId: number,
  callerJobName: string,
  options: ReporterOptions,
): Promise<ReporterResult> {
  const run = await readApi.get<WorkflowRun>(`repos/${repository}/actions/runs/${runId}`);
  verifyRun(run, repository, runId, callerJobName, options);
  const jobs = await readApi.getAll<WorkflowJob>(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`);
  verifyReporterJob(jobs, run.status);
  const tracked = mapTrackedJobs(jobs);
  for (const job of TRACKED_MACOS_JOBS) {
    const current = tracked.get(job.key);
    if (current === undefined) {
      throw new Error(`core CI run ${runId} is missing tracked macOS job ${job.key}`);
    }
    if (current.conclusion !== SUCCESS_CONCLUSION && !isFailureConclusion(current.conclusion)) {
      throw new Error(`core CI job ${job.name} has unsupported conclusion ${String(current.conclusion)}`);
    }
  }
  const actions: ReporterAction[] = [];
  const labelsReady = new Set<string>();
  const failedJobs = TRACKED_MACOS_JOBS.filter((job) => {
    const current = tracked.get(job.key);
    return current !== undefined && isFailureConclusion(current.conclusion);
  });
  const priorGreenRuns = failedJobs.length === 0
    ? new Map<string, WorkflowRun>()
    : await findLastGreenRuns(readApi, repository, failedJobs, run.run_number);

  for (const job of TRACKED_MACOS_JOBS) {
    const current = tracked.get(job.key);
    if (current === undefined) {
      throw new Error(`core CI run ${runId} is missing tracked macOS job ${job.key}`);
    }
    if (current.conclusion === SUCCESS_CONCLUSION) {
      actions.push(...await closeIncident(issueApi, repository, run, job, options));
      continue;
    }
    if (!isFailureConclusion(current.conclusion)) {
      throw new Error(`core CI job ${job.name} has unsupported conclusion ${String(current.conclusion)}`);
    }

    const priorGreen = priorGreenRuns.get(job.key);
    const compare = priorGreen === undefined
      ? undefined
      : await readApi.get<CompareResult>(`repos/${repository}/compare/${priorGreen.head_sha}...${run.head_sha}`);
    const labels = [ISSUE_LABEL, jobLabel(job)];
    if (!options.dryRun && !labelsReady.has(jobLabel(job))) {
      await ensureLabels(issueApi, repository, labels);
      labelsReady.add(jobLabel(job));
    }
    actions.push(...await openOrUpdateIncident(issueApi, repository, run, current, job, labels, compare, priorGreen, options));
  }

  return { actions };
}

function verifyRun(
  run: WorkflowRun,
  repository: string,
  expectedId: number,
  callerJobName: string,
  options: ReporterOptions,
): void {
  if (run.id !== expectedId) {
    throw new Error("GitHub Actions API returned a different run ID");
  }
  if (options.callerRunId !== expectedId || options.callerRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("run identity must match the current GitHub Actions caller context");
  }
  if (callerJobName !== REPORTER_JOB_NAME || options.callerJobName !== REPORTER_JOB_NAME) {
    throw new Error(`reporter must run from the ${REPORTER_JOB_NAME} caller job`);
  }
  if (run.repository.full_name.toLowerCase() !== repository.toLowerCase()
    || run.head_repository?.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("run did not originate from the trusted core repository");
  }
  if (run.path.split("@")[0] !== CI_WORKFLOW_PATH) {
    throw new Error("run did not originate from the core CI workflow");
  }
  if ((run.event !== "push" && run.event !== "schedule") || run.head_branch !== "main") {
    throw new Error("only core main push or schedule runs may update incidents");
  }
  if (run.status !== "completed" && run.status !== "in_progress") {
    throw new Error("core CI run is not in progress or completed");
  }
  if ((run.status === "completed" && run.conclusion === null)
    || (run.status === "in_progress" && run.conclusion !== null)) {
    throw new Error("core CI run has an inconsistent status and conclusion");
  }
  if (!SHA_PATTERN.test(run.head_sha)) {
    throw new Error("core CI run has an invalid head SHA");
  }
  if (!SHA_PATTERN.test(options.callerSha) || run.head_sha.toLowerCase() !== options.callerSha.toLowerCase()) {
    throw new Error("run head SHA must match the current GitHub Actions caller context");
  }
  if (!Number.isSafeInteger(run.run_number) || run.run_number < 1
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error("core CI run has invalid ordering metadata");
  }
}

function mapTrackedJobs(jobs: readonly WorkflowJob[]): Map<string, WorkflowJob> {
  const map = new Map<string, WorkflowJob>();
  for (const job of jobs) {
    const tracked = findTrackedJob(job.name);
    if (tracked !== undefined) {
      if (map.has(tracked.key)) {
        throw new Error(`core CI run contains duplicate tracked job ${tracked.key}`);
      }
      if (job.status !== "completed" || job.conclusion === null) {
        throw new Error(`core CI macOS job ${job.name} has not reached a terminal conclusion`);
      }
      map.set(tracked.key, job);
    }
  }
  return map;
}

function verifyReporterJob(jobs: readonly WorkflowJob[], runStatus: string): void {
  const reporterJobs = jobs.filter((job) => job.name === REPORTER_JOB_NAME);
  if (reporterJobs.length !== 1) {
    throw new Error("current reporter job is missing or duplicated in the Actions API response");
  }
  const reporter = reporterJobs[0];
  const expectedStatus = runStatus === "in_progress" ? "in_progress" : "completed";
  if (reporter === undefined || reporter.status !== expectedStatus
    || (runStatus === "in_progress" && reporter.conclusion !== null)
    || (runStatus === "completed" && reporter.conclusion === null)) {
    throw new Error("current reporter job is missing or does not match the caller run status");
  }
}

async function findLastGreenRuns(
  api: GithubApi,
  repository: string,
  jobsToFind: readonly TrackedMacosJob[],
  beforeRunNumber: number,
): Promise<Map<string, WorkflowRun>> {
  const found = new Map<string, WorkflowRun>();
  const unresolved = new Set(jobsToFind.map((job) => job.key));
  const candidates = await api.getAllFrom<WorkflowRun>(
    `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=100`,
    "workflow_runs",
  );
  const earlier = candidates
    .filter((candidate) => candidate.run_number < beforeRunNumber && candidate.status === "completed")
    .sort((left, right) => right.run_number - left.run_number);
  for (const candidate of earlier) {
    if (!trustedCompletedRun(candidate, repository)) {
      continue;
    }
    const jobs = await api.getAll<WorkflowJob>(
      `repos/${repository}/actions/runs/${candidate.id}/jobs?per_page=100`,
    );
    for (const previousJob of jobs) {
      const tracked = findTrackedJob(previousJob.name);
      if (tracked !== undefined && unresolved.has(tracked.key)
        && previousJob.status === "completed" && previousJob.conclusion === SUCCESS_CONCLUSION) {
        found.set(tracked.key, candidate);
        unresolved.delete(tracked.key);
      }
    }
    if (unresolved.size === 0) {
      break;
    }
  }
  return found;
}

function trustedCompletedRun(run: WorkflowRun, repository: string): boolean {
  return run.repository.full_name.toLowerCase() === repository.toLowerCase()
    && run.head_repository?.full_name.toLowerCase() === repository.toLowerCase()
    && run.path.split("@")[0] === CI_WORKFLOW_PATH
    && (run.event === "push" || run.event === "schedule")
    && run.head_branch === "main"
    && run.status === "completed"
    && SHA_PATTERN.test(run.head_sha);
}

function isFailureConclusion(conclusion: string | null): boolean {
  return conclusion !== null && FAILURE_CONCLUSIONS.has(conclusion);
}

async function ensureLabels(api: GithubApi, repository: string, labels: readonly string[]): Promise<void> {
  const existing = await api.getAll<{ readonly name: string }>(`repos/${repository}/labels?per_page=100`);
  const known = new Set(existing.map((label) => label.name.toLowerCase()));
  for (const name of labels) {
    if (!known.has(name.toLowerCase())) {
      await api.post(`repos/${repository}/labels`, {
        name,
        color: name === ISSUE_LABEL ? "b60205" : "d93f0b",
        description: name === ISSUE_LABEL
          ? "Automated report for a failing macOS job on main"
          : "Stable job key for a red-main incident",
      });
      known.add(name.toLowerCase());
    }
  }
}

async function openOrUpdateIncident(
  api: GithubApi,
  repository: string,
  run: WorkflowRun,
  jobRun: WorkflowJob,
  job: TrackedMacosJob,
  labels: readonly string[],
  compare: CompareResult | undefined,
  priorGreen: WorkflowRun | undefined,
  options: ReporterOptions,
): Promise<readonly ReporterAction[]> {
  const issues = await api.getAll<Issue>(
    `repos/${repository}/issues?state=open&labels=${encodeURIComponent(labels.join(","))}&per_page=100`,
  );
  const incident = issues.find((issue) => issue.pull_request === undefined
    && issue.labels.some((label) => label.name === jobLabel(job)));
  const newMetadata: IncidentMetadata = {
    jobKey: job.key,
    runId: run.id,
    runNumber: run.run_number,
    runAttempt: run.run_attempt,
  };
  const failure = failureDetails(run, jobRun, job, compare, priorGreen);
  if (incident === undefined) {
    const body = issueBody(newMetadata, failure);
    if (options.dryRun) {
      return [{ kind: "dry-run", jobKey: job.key, detail: `would create ${JSON.stringify(labels)}` }];
    }
    const created = await api.post<Issue>(`repos/${repository}/issues`, {
      title: `[macOS CI] ${job.name} failed on main`,
      body,
      labels,
    });
    return [{ kind: "create", jobKey: job.key, detail: `created issue #${created.number}` }];
  }

  const oldMetadata = metadata(incident.body);
  if (oldMetadata !== undefined && compareOrder(toRunOrder(newMetadata), toRunOrder(oldMetadata)) <= 0) {
    return [{ kind: "skip", jobKey: job.key, detail: `issue #${incident.number} already records an equal or newer run` }];
  }
  if (options.dryRun) {
    return [{ kind: "dry-run", jobKey: job.key, detail: `would comment on issue #${incident.number}` }];
  }

  const marker = runMarker(run);
  const comments = await api.getAll<IssueComment>(`repos/${repository}/issues/${incident.number}/comments?per_page=100`);
  if (!comments.some((comment) => comment.body.includes(marker))) {
    await api.post(`repos/${repository}/issues/${incident.number}/comments`, {
      body: `${marker}\n${failure}`,
    });
  }
  await api.patch(`repos/${repository}/issues/${incident.number}`, {
    body: issueBody(newMetadata, failure),
  });
  return [{ kind: "comment", jobKey: job.key, detail: `updated issue #${incident.number}` }];
}

async function closeIncident(
  api: GithubApi,
  repository: string,
  run: WorkflowRun,
  job: TrackedMacosJob,
  options: ReporterOptions,
): Promise<readonly ReporterAction[]> {
  const labels = [ISSUE_LABEL, jobLabel(job)];
  const issues = await api.getAll<Issue>(
    `repos/${repository}/issues?state=open&labels=${encodeURIComponent(labels.join(","))}&per_page=100`,
  );
  const incident = issues.find((issue) => issue.pull_request === undefined
    && issue.labels.some((label) => label.name === jobLabel(job)));
  if (incident === undefined) {
    return [];
  }
  const latest = metadata(incident.body);
  if (latest === undefined) {
    return [{ kind: "skip", jobKey: job.key, detail: `issue #${incident.number} has no ordering marker` }];
  }
  if (compareOrder(toRunOrder(run), toRunOrder(latest)) <= 0) {
    return [{ kind: "skip", jobKey: job.key, detail: `green run ${run.run_number} is older than issue #${incident.number}` }];
  }
  if (options.dryRun) {
    return [{ kind: "dry-run", jobKey: job.key, detail: `would close issue #${incident.number}` }];
  }
  const marker = runMarker(run);
  const comments = await api.getAll<IssueComment>(`repos/${repository}/issues/${incident.number}/comments?per_page=100`);
  if (!comments.some((comment) => comment.body.includes(marker))) {
    await api.post(`repos/${repository}/issues/${incident.number}/comments`, {
      body: `${marker}\nThe macOS job passed on main in [run #${run.run_number}](${run.html_url}). Closing this incident.`,
    });
  }
  await api.patch(`repos/${repository}/issues/${incident.number}`, { state: "closed" });
  return [{ kind: "close", jobKey: job.key, detail: `closed issue #${incident.number}` }];
}

function failureDetails(
  run: WorkflowRun,
  job: WorkflowJob,
  tracked: TrackedMacosJob,
  compare: CompareResult | undefined,
  priorGreen: WorkflowRun | undefined,
): string {
  const failures = job.steps.filter((step) => isFailureConclusion(step.conclusion));
  const stepText = failures.length === 0
    ? "No failed step was returned by the Actions API."
    : failures.map((step) => `- **${escapeMarkdown(step.name)}** (${String(step.conclusion)})`).join("\n");
  const rangeText = compare === undefined || priorGreen === undefined
    ? "No previous green main run for this job is available."
    : `[${priorGreen.head_sha.slice(0, 12)}..${run.head_sha.slice(0, 12)}](${compare.html_url}) (${compare.total_commits} commits)`;
  return [
    `Job **${escapeMarkdown(tracked.name)}** failed in [run #${run.run_number}](${run.html_url}).`,
    "",
    "Failing steps:",
    stepText,
    "",
    `Commit range since the last green run of this job: ${rangeText}.`,
  ].join("\n");
}

function issueBody(metadataValue: IncidentMetadata, details: string): string {
  return `${metadataMarker(metadataValue)}\n\n${details}`;
}

function metadataMarker(value: IncidentMetadata): string {
  return `<!-- pohunek-red-main: ${JSON.stringify(value)} -->`;
}

function metadata(body: string | null): IncidentMetadata | undefined {
  if (body === null) {
    return undefined;
  }
  const marker = /<!-- pohunek-red-main: (\{[^\n]+\}) -->/.exec(body)?.[1];
  if (marker === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(marker) as Partial<IncidentMetadata>;
    if (typeof parsed.jobKey === "string"
      && typeof parsed.runId === "number"
      && typeof parsed.runNumber === "number"
      && typeof parsed.runAttempt === "number") {
      return parsed as IncidentMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function toRunOrder(value: WorkflowRun | IncidentMetadata): RunOrder {
  return "run_number" in value
    ? { runNumber: value.run_number, attempt: value.run_attempt }
    : { runNumber: value.runNumber, attempt: value.runAttempt };
}

function compareOrder(left: RunOrder, right: RunOrder): number {
  return left.runNumber - right.runNumber || left.attempt - right.attempt;
}

function runMarker(run: WorkflowRun): string {
  return `<!-- pohunek-red-main-run: ${run.run_number}:${run.run_attempt} -->`;
}

function escapeMarkdown(value: string): string {
  let escaped = value;
  for (const character of ["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", ".", "!", "|", ">", "-"]) {
    escaped = escaped.replaceAll(character, `\\${character}`);
  }
  return escaped;
}
