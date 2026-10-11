import {
  CI_WORKFLOW_PATH,
  COLLECTOR_JOB_NAME,
  CORE_REPOSITORY,
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

type CollectedJob = Pick<WorkflowJob, "name" | "status" | "conclusion" | "steps">;

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
  readonly outcome: "failure" | "success";
}

interface HistoricalRun {
  readonly run: Pick<WorkflowRun, "id" | "run_number" | "run_attempt" | "head_sha">;
  readonly jobs: readonly Pick<WorkflowJob, "name" | "status" | "conclusion">[];
}

export interface CollectedSnapshot extends JsonObject {
  readonly version: number;
  readonly repository: string;
  readonly run: WorkflowRun;
  readonly jobs: readonly CollectedJob[];
  readonly history: readonly HistoricalRun[];
  readonly historyComplete: boolean;
  readonly freshness: Readonly<Record<string, "fresh" | "stale" | "uncertain">>;
  readonly comparisons: Readonly<Record<string, CompareResult | null>>;
  readonly collectorRunId: number;
  readonly collectorRepository: string;
  readonly collectorSha: string;
  readonly collectorJobName: string;
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
const MAX_HISTORY_RUNS = 50;
const MAX_SNAPSHOT_BYTES = 64 * 1024;

export async function reportCoreRun(
  readApi: GithubApi,
  issueApi: GithubApi,
  repository: string,
  runId: number,
  callerJobName: string,
  options: ReporterOptions,
): Promise<ReporterResult> {
  if (callerJobName !== options.callerJobName || callerJobName !== REPORTER_JOB_NAME) {
    throw new Error(`reporter wrapper must run from the ${REPORTER_JOB_NAME} job`);
  }
  const snapshot = await collectCoreRun(readApi, repository, runId, {
    callerRunId: options.callerRunId,
    callerRepository: options.callerRepository,
    callerSha: options.callerSha,
    callerJobName: COLLECTOR_JOB_NAME,
  });
  return reportCollectedSnapshot(issueApi, snapshot, options);
}

export async function collectCoreRun(
  readApi: GithubApi,
  repository: string,
  runId: number,
  caller: Omit<ReporterOptions, "dryRun">,
  compareApi: GithubApi = readApi,
): Promise<CollectedSnapshot> {
  const run = await readApi.get<WorkflowRun>(`repos/${repository}/actions/runs/${runId}`);
  verifyRun(run, repository, runId, caller.callerJobName, caller, COLLECTOR_JOB_NAME);
  const jobs = await readApi.getAllFrom<WorkflowJob>(
    `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
    "jobs",
  );
  verifyCallerJob(jobs, run.status, COLLECTOR_JOB_NAME);
  const tracked = mapTrackedJobs(jobs);
  for (const required of requiredJobsForEvent(run.event)) {
    const requiredJob = tracked.get(required.key);
    if (requiredJob === undefined || requiredJob.conclusion === "skipped") {
      throw new Error(`core CI run ${runId} is missing or skipped required macOS job ${required.key}`);
    }
  }
  for (const job of TRACKED_MACOS_JOBS) {
    const current = tracked.get(job.key);
    if (current !== undefined && current.conclusion !== SUCCESS_CONCLUSION
      && current.conclusion !== "skipped" && !isFailureConclusion(current.conclusion)) {
      throw new Error(`core CI job ${job.name} has unsupported conclusion ${String(current.conclusion)}`);
    }
  }
  const failedJobs = TRACKED_MACOS_JOBS.filter((job) => {
    const current = tracked.get(job.key);
    return current !== undefined && isFailureConclusion(current.conclusion);
  });
  const history = await collectHistory(readApi, repository);
  const freshness = assessFreshness(run, tracked, history);
  const priorGreenRuns = history.complete
    ? findLastGreenRunsFromHistory(history.runs, failedJobs, run.run_number)
    : new Map<string, Pick<WorkflowRun, "id" | "run_number" | "run_attempt" | "head_sha">>();
  const comparisons: Record<string, CompareResult | null> = {};
  for (const job of failedJobs) {
    const priorGreen = priorGreenRuns.get(job.key);
    if (priorGreen !== undefined) {
      try {
        comparisons[job.key] = await compareApi.get<CompareResult>(
          `repos/${repository}/compare/${priorGreen.head_sha}...${run.head_sha}`,
        );
      } catch {
        comparisons[job.key] = null;
      }
    }
  }

  const snapshot: CollectedSnapshot = {
    version: 1,
    repository,
    run,
    jobs: jobs.filter((job) => findTrackedJob(job.name) !== undefined).map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      steps: job.steps.map((step) => ({ name: step.name, conclusion: step.conclusion })),
    })),
    history: history.runs,
    historyComplete: history.complete,
    freshness,
    comparisons,
    collectorRunId: caller.callerRunId,
    collectorRepository: caller.callerRepository,
    collectorSha: caller.callerSha,
    collectorJobName: caller.callerJobName,
  };
  const encoded = JSON.stringify(snapshot);
  if (new TextEncoder().encode(encoded).length > MAX_SNAPSHOT_BYTES) {
    throw new Error(`collected reporter snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  return snapshot;
}

export async function reportCollectedSnapshot(
  issueApi: GithubApi,
  snapshot: CollectedSnapshot,
  options: ReporterOptions,
): Promise<ReporterResult> {
  verifySnapshot(snapshot, options);
  const { run, jobs } = snapshot;
  const tracked = mapTrackedJobs(jobs);
  for (const required of requiredJobsForEvent(run.event)) {
    const requiredJob = tracked.get(required.key);
    if (requiredJob === undefined || requiredJob.conclusion === "skipped") {
      throw new Error(`collected snapshot is missing or skips required macOS job ${required.key}`);
    }
  }
  for (const job of tracked.values()) {
    if (job.conclusion !== SUCCESS_CONCLUSION && job.conclusion !== "skipped"
      && !isFailureConclusion(job.conclusion)) {
      throw new Error(`collected snapshot has unsupported conclusion ${String(job.conclusion)}`);
    }
  }
  const latestRuns = new Map<string, HistoricalRun>();
  for (const record of snapshot.history) {
    for (const job of record.jobs) {
      const trackedJob = findTrackedJob(job.name);
      if (trackedJob === undefined || job.status !== "completed" || job.conclusion === "skipped") {
        continue;
      }
      const latest = latestRuns.get(trackedJob.key);
      if (latest === undefined || compareOrder(toRunOrder(record.run), toRunOrder(latest.run)) > 0) {
        latestRuns.set(trackedJob.key, record);
      }
    }
  }
  const actions: ReporterAction[] = [];
  const labelsReady = new Set<string>();
  for (const job of TRACKED_MACOS_JOBS) {
    const current = tracked.get(job.key);
    if (current === undefined || current.conclusion === "skipped") {
      continue;
    }
    if (snapshot.freshness[job.key] !== "fresh") {
      const state = snapshot.freshness[job.key] ?? "uncertain";
      actions.push({
        kind: "skip",
        jobKey: job.key,
        detail: state === "stale"
          ? "a newer completed run already has an outcome for this job"
          : "latest outcome for this job could not be verified",
      });
      continue;
    }
    const latestObserved = latestRuns.get(job.key);
    if (latestObserved !== undefined && compareOrder(toRunOrder(latestObserved.run), toRunOrder(run)) > 0) {
      actions.push({ kind: "skip", jobKey: job.key, detail: `newer run #${latestObserved.run.run_number} already recorded` });
      continue;
    }
    if (current.conclusion === SUCCESS_CONCLUSION) {
      actions.push(...await closeIncident(issueApi, snapshot.repository, run, job, options));
      continue;
    }
    if (!isFailureConclusion(current.conclusion)) {
      throw new Error(`core CI job ${job.name} has unsupported conclusion ${String(current.conclusion)}`);
    }

    const priorGreen = snapshot.historyComplete
      ? findLastGreenRunsFromHistory(snapshot.history, [job], run.run_number).get(job.key)
      : undefined;
    const compare = snapshot.comparisons[job.key] ?? undefined;
    const labels = [ISSUE_LABEL, jobLabel(job)];
    if (!options.dryRun && !labelsReady.has(jobLabel(job))) {
      await ensureLabels(issueApi, snapshot.repository, labels);
      labelsReady.add(jobLabel(job));
    }
    actions.push(...await openOrUpdateIncident(
      issueApi,
      snapshot.repository,
      run,
      current,
      job,
      labels,
      compare ?? undefined,
      priorGreen,
      snapshot.historyComplete,
      options,
    ));
  }
  return { actions };
}

function verifyRun(
  run: WorkflowRun,
  repository: string,
  expectedId: number,
  callerJobName: string,
  options: Omit<ReporterOptions, "dryRun">,
  expectedJobName: string,
): void {
  if (run.id !== expectedId) {
    throw new Error("GitHub Actions API returned a different run ID");
  }
  if (options.callerRunId !== expectedId || options.callerRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("run identity must match the current GitHub Actions caller context");
  }
  if (callerJobName !== expectedJobName || options.callerJobName !== expectedJobName) {
    throw new Error(`run collector must execute from the ${expectedJobName} caller job`);
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

function mapTrackedJobs(jobs: readonly CollectedJob[]): Map<string, CollectedJob> {
  const map = new Map<string, CollectedJob>();
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

function requiredJobsForEvent(event: string): readonly TrackedMacosJob[] {
  const requiredKeys = new Set([
    "platform-contracts-arm64",
    "macos-package-macos-15",
    "sdk-workspace-macos-arm64",
  ]);
  if (event === "schedule") {
    requiredKeys.add("macos-package-macos-14");
  }
  return TRACKED_MACOS_JOBS.filter((job) => requiredKeys.has(job.key));
}

function verifyCallerJob(jobs: readonly WorkflowJob[], runStatus: string, expectedJobName: string): void {
  const callerJobs = jobs.filter((job) => job.name === expectedJobName);
  if (callerJobs.length !== 1) {
    throw new Error(`current ${expectedJobName} job is missing or duplicated in the Actions API response`);
  }
  const caller = callerJobs[0];
  const expectedStatus = runStatus === "in_progress" ? "in_progress" : "completed";
  if (caller === undefined || caller.status !== expectedStatus
    || (runStatus === "in_progress" && caller.conclusion !== null)
    || (runStatus === "completed" && caller.conclusion === null)) {
    throw new Error(`current ${expectedJobName} job does not match the caller run status`);
  }
}

interface HistoryResult {
  readonly runs: readonly HistoricalRun[];
  readonly complete: boolean;
  readonly runListAvailable: boolean;
  readonly candidateCount: number;
  readonly oldestCandidateRunNumber: number | undefined;
  readonly failedRunOrders: readonly RunOrder[];
}

async function collectHistory(
  api: GithubApi,
  repository: string,
): Promise<HistoryResult> {
  const records: HistoricalRun[] = [];
  const failedRunOrders: RunOrder[] = [];
  let candidates: readonly WorkflowRun[];
  try {
    candidates = await api.getAllFrom<WorkflowRun>(
      `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=${MAX_HISTORY_RUNS}`,
      "workflow_runs",
      MAX_HISTORY_RUNS,
    );
  } catch {
    return {
      runs: records,
      complete: false,
      runListAvailable: false,
      candidateCount: 0,
      oldestCandidateRunNumber: undefined,
      failedRunOrders,
    };
  }
  let complete = true;
  for (const [index, candidate] of candidates.entries()) {
    if (!trustedCompletedRun(candidate, repository)) {
      continue;
    }
    let jobs: readonly WorkflowJob[];
    try {
      jobs = await api.getAllFrom<WorkflowJob>(
        `repos/${repository}/actions/runs/${candidate.id}/jobs?per_page=100`,
        "jobs",
        100,
      );
    } catch {
      complete = false;
      failedRunOrders.push({ runNumber: candidate.run_number, attempt: candidate.run_attempt });
      for (const remaining of candidates.slice(index + 1)) {
        if (trustedCompletedRun(remaining, repository)) {
          failedRunOrders.push({ runNumber: remaining.run_number, attempt: remaining.run_attempt });
        }
      }
      break;
    }
    records.push({
      run: {
        id: candidate.id,
        run_number: candidate.run_number,
        run_attempt: candidate.run_attempt,
        head_sha: candidate.head_sha,
      },
      jobs: jobs.filter((job) => findTrackedJob(job.name) !== undefined).map((job) => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
      })),
    });
  }
  return {
    runs: records,
    complete,
    runListAvailable: true,
    candidateCount: candidates.length,
    oldestCandidateRunNumber: candidates.length === 0
      ? undefined
      : Math.min(...candidates.map((candidate) => candidate.run_number)),
    failedRunOrders,
  };
}

function assessFreshness(
  currentRun: WorkflowRun,
  currentJobs: ReadonlyMap<string, CollectedJob>,
  history: HistoryResult,
): Readonly<Record<string, "fresh" | "stale" | "uncertain">> {
  const freshness: Record<string, "fresh" | "stale" | "uncertain"> = {};
  for (const tracked of TRACKED_MACOS_JOBS) {
    const currentJob = currentJobs.get(tracked.key);
    if (currentJob === undefined || currentJob.conclusion === "skipped") {
      continue;
    }
    const newerOutcome = history.runs.some((record) =>
      compareOrder(toRunOrder(record.run), toRunOrder(currentRun)) > 0
      && record.jobs.some((job) => job.name === tracked.name
        && job.status === "completed" && job.conclusion !== "skipped"));
    if (newerOutcome) {
      freshness[tracked.key] = "stale";
      continue;
    }
    const failedLaterRead = history.failedRunOrders.some((order) =>
      compareOrder(order, toRunOrder(currentRun)) > 0);
    const truncatedBeforeCurrent = history.candidateCount >= MAX_HISTORY_RUNS
      && history.oldestCandidateRunNumber !== undefined
      && currentRun.run_number < history.oldestCandidateRunNumber;
    freshness[tracked.key] = !history.runListAvailable || failedLaterRead || truncatedBeforeCurrent
      ? "uncertain"
      : "fresh";
  }
  return freshness;
}

function findLastGreenRunsFromHistory(
  records: readonly HistoricalRun[],
  jobsToFind: readonly TrackedMacosJob[],
  beforeRunNumber: number,
): Map<string, Pick<WorkflowRun, "id" | "run_number" | "run_attempt" | "head_sha">> {
  const found = new Map<string, Pick<WorkflowRun, "id" | "run_number" | "run_attempt" | "head_sha">>();
  for (const job of jobsToFind) {
    const green = records
      .filter((record) => record.run.run_number < beforeRunNumber && record.jobs.some((candidate) => candidate.name === job.name
        && candidate.status === "completed" && candidate.conclusion === SUCCESS_CONCLUSION))
      .sort((left, right) => compareOrder(toRunOrder(right.run), toRunOrder(left.run)))[0];
    if (green !== undefined) {
      found.set(job.key, green.run);
    }
  }
  return found;
}

function verifySnapshot(snapshot: CollectedSnapshot, options: ReporterOptions): void {
  if (snapshot.version !== 1 || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.history)
    || snapshot.repository !== CORE_REPOSITORY
    || snapshot.collectorJobName !== COLLECTOR_JOB_NAME
    || snapshot.collectorRunId !== options.callerRunId
    || snapshot.collectorRepository.toLowerCase() !== options.callerRepository.toLowerCase()
    || snapshot.collectorSha.toLowerCase() !== options.callerSha.toLowerCase()) {
    throw new Error("collected snapshot does not match the trusted current caller context");
  }
  if (options.callerJobName !== REPORTER_JOB_NAME
    || snapshot.run.id !== options.callerRunId
    || snapshot.run.path.split("@")[0] !== CI_WORKFLOW_PATH
    || (snapshot.run.event !== "push" && snapshot.run.event !== "schedule")
    || snapshot.run.head_branch !== "main"
    || (snapshot.run.status !== "in_progress" && snapshot.run.status !== "completed")
    || snapshot.run.repository.full_name.toLowerCase() !== options.callerRepository.toLowerCase()
    || snapshot.run.head_repository?.full_name.toLowerCase() !== options.callerRepository.toLowerCase()
    || !SHA_PATTERN.test(snapshot.run.head_sha)
    || snapshot.run.head_sha.toLowerCase() !== options.callerSha.toLowerCase()) {
    throw new Error(`snapshot must be consumed by the ${REPORTER_JOB_NAME} job for its caller run`);
  }
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
  jobRun: CollectedJob,
  job: TrackedMacosJob,
  labels: readonly string[],
  compare: CompareResult | undefined,
  priorGreen: Pick<WorkflowRun, "id" | "run_number" | "run_attempt" | "head_sha"> | undefined,
  historyComplete: boolean,
  options: ReporterOptions,
): Promise<readonly ReporterAction[]> {
  const issues = await api.getAll<Issue>(
    `repos/${repository}/issues?state=all&labels=${encodeURIComponent(labels.join(","))}&per_page=100`,
  );
  const incident = latestIncident(issues, job);
  const newMetadata: IncidentMetadata = {
    jobKey: job.key,
    runId: run.id,
    runNumber: run.run_number,
    runAttempt: run.run_attempt,
    outcome: "failure",
  };
  const failure = failureDetails(run, jobRun, job, compare, priorGreen, historyComplete);
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
    ...(incident.state === "closed" ? { state: "open" } : {}),
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
    `repos/${repository}/issues?state=all&labels=${encodeURIComponent(labels.join(","))}&per_page=100`,
  );
  const incident = latestIncident(issues, job);
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
  const recovered: IncidentMetadata = {
    jobKey: job.key,
    runId: run.id,
    runNumber: run.run_number,
    runAttempt: run.run_attempt,
    outcome: "success",
  };
  await api.patch(`repos/${repository}/issues/${incident.number}`, {
    state: "closed",
    body: issueBody(recovered, `Job **${escapeMarkdown(job.name)}** passed in [run #${run.run_number}](${run.html_url}).`),
  });
  return [{ kind: "close", jobKey: job.key, detail: `closed issue #${incident.number}` }];
}

function latestIncident(issues: readonly Issue[], job: TrackedMacosJob): Issue | undefined {
  return issues
    .filter((issue) => issue.pull_request === undefined
      && issue.labels.some((label) => label.name === jobLabel(job)))
    .sort((left, right) => {
      const leftOrder = metadata(left.body);
      const rightOrder = metadata(right.body);
      if (leftOrder === undefined) return rightOrder === undefined ? right.number - left.number : 1;
      if (rightOrder === undefined) return -1;
      return compareOrder(toRunOrder(rightOrder), toRunOrder(leftOrder)) || right.number - left.number;
    })[0];
}

function failureDetails(
  run: WorkflowRun,
  job: CollectedJob,
  tracked: TrackedMacosJob,
  compare: CompareResult | undefined,
  priorGreen: Pick<WorkflowRun, "id" | "run_number" | "run_attempt" | "head_sha"> | undefined,
  historyComplete: boolean,
): string {
  const failures = job.steps.filter((step) => isFailureConclusion(step.conclusion));
  const stepText = failures.length === 0
    ? "No failed step was returned by the Actions API."
    : failures.map((step) => `- **${escapeMarkdown(step.name)}** (${String(step.conclusion)})`).join("\n");
  const rangeText = priorGreen === undefined && !historyComplete
    ? "History lookup was unavailable; the previous green run could not be determined."
    : priorGreen === undefined
    ? "No previous green main run for this job is available."
    : compare === undefined
      ? `Previous green run #${priorGreen.run_number} was found, but compare details are unavailable.`
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
      && typeof parsed.runAttempt === "number"
      && (parsed.outcome === "failure" || parsed.outcome === "success")) {
      return parsed as IncidentMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function toRunOrder(
  value: Pick<WorkflowRun, "run_number" | "run_attempt"> | IncidentMetadata,
): RunOrder {
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
