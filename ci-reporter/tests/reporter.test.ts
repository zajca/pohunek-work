import { describe, expect, test } from "bun:test";
import { COLLECTOR_JOB_NAME, CORE_REPOSITORY, TRACKED_MACOS_JOBS, jobLabel, ISSUE_LABEL, REPORTER_JOB_NAME } from "../src/config.ts";
import { GithubRestApi, type GithubApi, type JsonObject } from "../src/github.ts";
import {
  collectCoreRun,
  reportCollectedSnapshot,
  reportCoreRun,
  type ReporterResult,
} from "../src/reporter.ts";

interface TestRun extends JsonObject {
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
  readonly head_repository: { readonly full_name: string };
}

interface TestIssue extends JsonObject {
  readonly number: number;
  title: string;
  body: string | null;
  state: string;
  labels: readonly { readonly name: string }[];
}

interface TestJob extends JsonObject {
  readonly id: number;
  readonly run_id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly run_url: string;
  readonly steps: readonly { readonly name: string; readonly conclusion: string | null }[];
}

class MemoryGithubApi implements GithubApi {
  public readonly writes: { readonly method: string; readonly path: string; readonly body: JsonObject }[] = [];
  public readonly issues: TestIssue[] = [];
  public readonly labels = new Set<string>();
  public readonly comments = new Map<number, { body: string }[]>();
  public readonly runs = new Map<number, TestRun>();
  public readonly jobs = new Map<number, TestJob[]>();
  public readonly comparisons: string[] = [];
  public readonly historyLimits: number[] = [];
  public readonly historyJobReads: number[] = [];
  public comparePayloadBytes = 0;
  public failHistoryReads = false;
  public readonly failedHistoryJobReads = new Set<number>();
  public failCompareReads = false;
  public failNextClosePatch = false;
  public loseNextWatermarkCreateAck = false;
  public loseNextWatermarkUpdateAck = false;
  private nextIssueNumber = 1;

  public constructor(...runs: TestRun[]) {
    for (const run of runs) {
      this.runs.set(run.id, run);
    }
  }

  public get<T>(path: string): Promise<T> {
    const runId = /actions\/runs\/(\d+)$/.exec(path)?.[1];
    if (runId !== undefined) {
      return Promise.resolve(this.runs.get(Number(runId)) as T);
    }
    const comparePath = /compare\/([^?]+)/.exec(path)?.[1];
    if (comparePath !== undefined) {
      this.comparisons.push(comparePath);
      if (this.failCompareReads) {
        return Promise.reject(new Error("compare endpoint unavailable"));
      }
      return Promise.resolve({
        html_url: `https://github.com/${CORE_REPOSITORY}/compare/${comparePath}`,
        total_commits: 7,
        files: "x".repeat(this.comparePayloadBytes),
      } as T);
    }
    throw new Error(`unexpected GET ${path}`);
  }

  public getAll<T>(path: string): Promise<readonly T[]> {
    const issueComments = /issues\/(\d+)\/comments/.exec(path)?.[1];
    if (issueComments !== undefined) {
      return Promise.resolve((this.comments.get(Number(issueComments)) ?? []) as T[]);
    }
    if (path.endsWith("/labels?per_page=100")) {
      return Promise.resolve([...this.labels].map((name) => ({ name })) as T[]);
    }
    if (path.includes("/issues?state=all&labels=")) {
      const labelsValue = new URLSearchParams(path.split("?")[1]).get("labels");
      const wanted = labelsValue?.split(",") ?? [];
      return Promise.resolve(this.issues.filter((issue) =>
        wanted.every((name) => issue.labels.some((label) => label.name === name))) as T[]);
    }
    throw new Error(`unexpected GET all ${path}`);
  }

  public getAllFrom<T>(path: string, collectionKey: string, maxItems?: number): Promise<readonly T[]> {
    const jobsRunId = /actions\/runs\/(\d+)\/jobs/.exec(path)?.[1];
    if (collectionKey === "jobs" && jobsRunId !== undefined) {
      const id = Number(jobsRunId);
      this.historyJobReads.push(id);
      if (this.failedHistoryJobReads.has(id)) {
        return Promise.reject(new Error("Actions job history unavailable"));
      }
      return Promise.resolve((this.jobs.get(id) ?? []) as T[]);
    }
    if (collectionKey !== "workflow_runs") {
      throw new Error(`unexpected collection key ${collectionKey}`);
    }
    this.historyLimits.push(maxItems ?? Number.MAX_SAFE_INTEGER);
    if (this.failHistoryReads) {
      return Promise.reject(new Error("Actions history rate limit exceeded"));
    }
    return Promise.resolve([...this.runs.values()]
      .sort((left, right) => right.run_number - left.run_number)
      .slice(0, maxItems) as T[]);
  }

  public post<T>(path: string, body: JsonObject): Promise<T> {
    this.writes.push({ method: "POST", path, body });
    if (path.endsWith("/labels")) {
      this.labels.add(String(body["name"]));
      return Promise.resolve({ name: body["name"] } as T);
    }
    const issueComments = /issues\/(\d+)\/comments/.exec(path)?.[1];
    if (issueComments !== undefined) {
      const comments = this.comments.get(Number(issueComments)) ?? [];
      comments.push({ body: String(body["body"]) });
      this.comments.set(Number(issueComments), comments);
      return Promise.resolve({} as T);
    }
    if (path.endsWith("/issues")) {
      const issue: TestIssue = {
        number: this.nextIssueNumber++,
        title: String(body["title"]),
        body: String(body["body"]),
        state: "open",
        labels: (body["labels"] as string[]).map((name) => ({ name })),
      };
      this.issues.push(issue);
      if (issue.labels.some((label) => label.name === "red-main-watermark")
        && this.loseNextWatermarkCreateAck) {
        this.loseNextWatermarkCreateAck = false;
        return Promise.reject(new Error("watermark create acknowledgement lost"));
      }
      return Promise.resolve(issue as T);
    }
    throw new Error(`unexpected POST ${path}`);
  }

  public patch<T>(path: string, body: JsonObject): Promise<T> {
    const issueNumber = /issues\/(\d+)$/.exec(path)?.[1];
    const issue = this.issues.find((item) => item.number === Number(issueNumber));
    if (issue === undefined) {
      throw new Error(`unexpected PATCH ${path}`);
    }
    if (body["state"] === "closed" && this.failNextClosePatch
      && issue.labels.some((label) => label.name === ISSUE_LABEL)) {
      this.failNextClosePatch = false;
      return Promise.reject(new Error("temporary patch failure"));
    }
    this.writes.push({ method: "PATCH", path, body });
    if (typeof body["body"] === "string") {
      issue.body = body["body"];
    }
    if (typeof body["state"] === "string") {
      issue.state = body["state"];
    }
    if (issue.labels.some((label) => label.name === "red-main-watermark")
      && typeof body["body"] === "string" && this.loseNextWatermarkUpdateAck) {
      this.loseNextWatermarkUpdateAck = false;
      return Promise.reject(new Error("watermark update acknowledgement lost"));
    }
    return Promise.resolve(issue as T);
  }
}

function run(
  id: number,
  runNumber: number,
  conclusion: string | null = "failure",
  status: string = "completed",
  event: string = "push",
): TestRun {
  return {
    id,
    run_number: runNumber,
    run_attempt: 1,
    event,
    head_branch: "main",
    head_sha: id.toString(16).padStart(40, "0"),
    status,
    conclusion,
    path: ".github/workflows/ci.yml@refs/heads/main",
    html_url: `https://github.com/${CORE_REPOSITORY}/actions/runs/${id}`,
    repository: { full_name: CORE_REPOSITORY },
    head_repository: { full_name: CORE_REPOSITORY },
  };
}

function jobFixtures(runId: number, failingKey?: string, reporterStatus: string = "completed"): TestJob[] {
  const trackedJobs = TRACKED_MACOS_JOBS.map((tracked, index) => {
    const failed = tracked.key === failingKey;
    return {
      id: runId * 10 + index,
      run_id: runId,
      name: tracked.name,
      status: "completed",
      conclusion: failed ? "failure" : "success",
      html_url: `https://github.com/${CORE_REPOSITORY}/actions/runs/${runId}/job/${runId * 10 + index}`,
      run_url: `https://api.github.com/repos/${CORE_REPOSITORY}/actions/runs/${runId}`,
      steps: [
        { name: "checkout", conclusion: "success" },
        { name: failed ? "Package install acceptance" : "test", conclusion: failed ? "failure" : "success" },
      ],
    };
  });
  return [...trackedJobs, {
    id: runId * 10 + trackedJobs.length,
    run_id: runId,
    name: REPORTER_JOB_NAME,
    status: reporterStatus,
    conclusion: reporterStatus === "completed" ? "success" : null,
    html_url: `https://github.com/${CORE_REPOSITORY}/actions/runs/${runId}/job/reporter`,
    run_url: `https://api.github.com/repos/${CORE_REPOSITORY}/actions/runs/${runId}`,
    steps: [],
  }, {
    id: runId * 10 + trackedJobs.length + 1,
    run_id: runId,
    name: COLLECTOR_JOB_NAME,
    status: reporterStatus,
    conclusion: reporterStatus === "completed" ? "success" : null,
    html_url: `https://github.com/${CORE_REPOSITORY}/actions/runs/${runId}/job/collector`,
    run_url: `https://api.github.com/repos/${CORE_REPOSITORY}/actions/runs/${runId}`,
    steps: [],
  }];
}

function setupFailingRun(): MemoryGithubApi {
  const api = new MemoryGithubApi(
    run(90, 90, "failure", "completed", "schedule"),
    run(100, 100, null, "in_progress"),
  );
  api.jobs.set(90, jobFixtures(90));
  api.jobs.set(100, jobFixtures(100, "macos-package-macos-15", "in_progress"));
  return api;
}

function report(api: MemoryGithubApi, runId: number, dryRun: boolean): Promise<ReporterResult> {
  return reportCoreRun(api, api, CORE_REPOSITORY, runId, REPORTER_JOB_NAME, {
    dryRun,
    callerRunId: runId,
    callerRepository: CORE_REPOSITORY,
    callerSha: api.runs.get(runId)?.head_sha ?? "0".repeat(40),
    callerJobName: REPORTER_JOB_NAME,
  });
}

function incidentIssues(api: MemoryGithubApi): TestIssue[] {
  return api.issues.filter((issue) => issue.labels.some((label) => label.name === ISSUE_LABEL));
}

function incidentForJob(api: MemoryGithubApi, key = "macos-package-macos-15"): TestIssue | undefined {
  const job = TRACKED_MACOS_JOBS.find((candidate) => candidate.key === key);
  if (job === undefined) {
    throw new Error(`unknown tracked job ${key}`);
  }
  return incidentIssues(api).find((issue) => issue.labels.some((label) => label.name === jobLabel(job)));
}

function watermarkForJob(api: MemoryGithubApi, key: string): TestIssue | undefined {
  const job = TRACKED_MACOS_JOBS.find((candidate) => candidate.key === key);
  if (job === undefined) {
    throw new Error(`unknown tracked job ${key}`);
  }
  return api.issues.find((issue) => issue.labels.some((label) => label.name === "red-main-watermark")
    && issue.labels.some((label) => label.name === jobLabel(job)));
}

describe("red-main incident reporter", () => {
  test("projects bounded run and compare fields before serializing the workflow snapshot", async () => {
    const api = setupFailingRun();
    const current = api.runs.get(100);
    expect(current).toBeDefined();
    api.runs.set(100, {
      ...(current as TestRun),
      webhook_payload: "x".repeat(72 * 1024),
    });
    api.comparePayloadBytes = 72 * 1024;
    api.jobs.set(100, jobFixtures(100, "macos-package-macos-15", "in_progress").map((job) => ({
      ...job,
      raw_logs: "x".repeat(16 * 1024),
      steps: job.steps.map((step) => ({ ...step, raw_log: "x".repeat(16 * 1024) })),
    })));

    const callerSha = api.runs.get(100)?.head_sha ?? "0".repeat(40);
    const snapshot = await collectCoreRun(api, CORE_REPOSITORY, 100, {
      callerRunId: 100,
      callerRepository: CORE_REPOSITORY,
      callerSha,
      callerJobName: COLLECTOR_JOB_NAME,
    });

    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThan(64 * 1024);
    expect(snapshot.run).not.toHaveProperty("webhook_payload");
    expect(snapshot.jobs.every((job) => !("raw_logs" in job))).toBe(true);
    expect(snapshot.comparisons["macos-package-macos-15"]).not.toHaveProperty("files");

    const writer = new MemoryGithubApi();
    const result = await reportCollectedSnapshot(writer, snapshot, {
      dryRun: false,
      callerRunId: 100,
      callerRepository: CORE_REPOSITORY,
      callerSha,
      callerJobName: REPORTER_JOB_NAME,
    });
    expect(result.actions.some((action) => action.kind === "create"
      && action.jobKey === "macos-package-macos-15")).toBe(true);
    expect(incidentIssues(writer)).toHaveLength(1);
  });

  test("reads GitHub Actions jobs from the REST API jobs collection envelope", async () => {
    const apiData = setupFailingRun();
    const writer = new MemoryGithubApi();
    const authorizationHeaders: string[] = [];
    const fetcher = (input: string, init: RequestInit): Promise<Response> => {
      authorizationHeaders.push(new Headers(init.headers).get("authorization") ?? "");
      const url = new URL(input);
      const currentRunId = /actions\/runs\/(\d+)$/.exec(url.pathname)?.[1];
      if (currentRunId !== undefined) {
        return Promise.resolve(Response.json(apiData.runs.get(Number(currentRunId))));
      }
      const jobsRunId = /actions\/runs\/(\d+)\/jobs$/.exec(url.pathname)?.[1];
      if (jobsRunId !== undefined) {
        return Promise.resolve(Response.json({ jobs: apiData.jobs.get(Number(jobsRunId)) ?? [] }));
      }
      if (url.pathname.endsWith("/actions/workflows/ci.yml/runs")) {
        return Promise.resolve(Response.json({
          workflow_runs: [apiData.runs.get(90)],
        }));
      }
      if (/\/compare\//.test(url.pathname)) {
        return Promise.resolve(Response.json({ html_url: "https://github.com/compare", total_commits: 7 }));
      }
      throw new Error(`unexpected HTTP GET ${url.pathname}`);
    };
    const readApi = new GithubRestApi("actions-read-only-token", fetcher);
    const compareApi = new GithubRestApi(undefined, fetcher);

    const callerSha = apiData.runs.get(100)?.head_sha ?? "0".repeat(40);
    const snapshot = await collectCoreRun(readApi, CORE_REPOSITORY, 100, {
      callerRunId: 100,
      callerRepository: CORE_REPOSITORY,
      callerSha,
      callerJobName: COLLECTOR_JOB_NAME,
    }, compareApi);
    const result = await reportCollectedSnapshot(writer, snapshot, {
      dryRun: false,
      callerRunId: 100,
      callerRepository: CORE_REPOSITORY,
      callerSha,
      callerJobName: REPORTER_JOB_NAME,
    });

    expect(result.actions.some((action) => action.kind === "create")).toBe(true);
    expect(incidentIssues(writer)).toHaveLength(1);
    expect(authorizationHeaders).toContain("Bearer actions-read-only-token");
    expect(authorizationHeaders).toContain("");
  });

  test("creates one labeled issue with failing step, run link and range from the last green job run", async () => {
    const api = setupFailingRun();
    const result = await report(api, 100, false);

    expect(result.actions.some((action) => action.kind === "create"
      && action.jobKey === "macos-package-macos-15")).toBe(true);
    expect(incidentIssues(api)).toHaveLength(1);
    const incident = incidentForJob(api);
    expect(incident?.labels.map((label) => label.name)).toEqual([
      ISSUE_LABEL,
      jobLabel(TRACKED_MACOS_JOBS.find((job) => job.key === "macos-package-macos-15") ?? {
        key: "missing",
        name: "missing",
      }),
    ]);
    expect(incident?.body).toContain("Package install acceptance");
    expect(incident?.body).toContain("actions/runs/100");
    expect(incident?.body).toContain("(7 commits)");
    expect(incident?.body).toContain("/compare/000000000000000000000000000000000000005a...0000000000000000000000000000000000000064");
    expect(api.comparisons).toEqual([
      "000000000000000000000000000000000000005a...0000000000000000000000000000000000000064",
    ]);
    expect(watermarkForJob(api, "macos-package-macos-15")?.body).toContain('"outcome":"failure"');
  });

  test("duplicate delivery does not create a second issue or write again", async () => {
    const api = setupFailingRun();
    await report(api, 100, false);
    const writeCount = api.writes.length;
    const duplicate = await report(api, 100, false);

    expect(incidentIssues(api)).toHaveLength(1);
    expect(api.writes).toHaveLength(writeCount);
    expect(duplicate.actions.some((action) => action.kind === "skip")).toBe(true);
  });

  test("comments on a newer failure, ignores a stale green run, and closes on a later green run", async () => {
    const api = setupFailingRun();
    await report(api, 100, false);
    const newerRed = run(102, 102, null, "in_progress");
    api.runs.set(102, newerRed);
    api.jobs.set(102, jobFixtures(102, "macos-package-macos-15", "in_progress"));
    const commentResult = await report(api, 102, false);
    expect(commentResult.actions.some((action) => action.kind === "comment")).toBe(true);

    const staleGreen = run(101, 101, "success");
    api.runs.set(101, staleGreen);
    api.jobs.set(101, jobFixtures(101));
    const staleResult = await report(api, 101, false);
    expect(staleResult.actions.some((action) => action.kind === "skip"
      && action.jobKey === "macos-package-macos-15")).toBe(true);
    expect(incidentForJob(api)?.state).toBe("open");

    const laterGreen = run(103, 103, "success");
    api.runs.set(103, laterGreen);
    api.jobs.set(103, jobFixtures(103));
    api.failNextClosePatch = true;
    await expectFailure(report(api, 103, false), "temporary patch failure");
    const incidentNumber = incidentForJob(api)?.number;
    expect(api.comments.get(incidentNumber ?? -1)?.filter((comment) => comment.body.includes("actions/runs/103"))).toHaveLength(1);
    const closeResult = await report(api, 103, false);
    expect(closeResult.actions.some((action) => action.kind === "close")).toBe(true);
    expect(incidentForJob(api)?.state).toBe("closed");
    expect(api.comments.get(incidentNumber ?? -1)?.some((comment) => comment.body.includes("actions/runs/103"))).toBe(true);
  });

  test("retains the green high-water mark after close and rejects late failure delivery", async () => {
    const api = setupFailingRun();
    await report(api, 100, false);
    const green = run(101, 101, "success");
    api.runs.set(101, green);
    api.jobs.set(101, jobFixtures(101));
    await report(api, 101, false);
    expect(incidentForJob(api)?.state).toBe("closed");
    expect(incidentForJob(api)?.body).toContain('"outcome":"success"');

    const late = await report(api, 100, false);

    expect(late.actions.some((action) => action.kind === "skip")).toBe(true);
    expect(incidentIssues(api)).toHaveLength(1);
    expect(incidentForJob(api)?.state).toBe("closed");
  });

  test("a green run delivered before an older failure suppresses stale issue creation", async () => {
    const red = run(100, 100, null, "in_progress");
    const green = run(101, 101, "success");
    const api = new MemoryGithubApi(red, green);
    api.jobs.set(100, jobFixtures(100, "macos-package-macos-15", "in_progress"));
    api.jobs.set(101, jobFixtures(101));

    const result = await report(api, 100, false);

    expect(result.actions.some((action) => action.kind === "skip"
      && action.jobKey === "macos-package-macos-15")).toBe(true);
    expect(api.issues).toHaveLength(0);
    expect(api.writes).toHaveLength(0);
  });

  test("persists green outcomes so an older failure stays suppressed after history ages out", async () => {
    const green = run(101, 101, "success");
    const api = new MemoryGithubApi(green);
    api.jobs.set(101, jobFixtures(101));

    await report(api, 101, false);

    const watermarkIssues = api.issues.filter((issue) => issue.labels.some((label) => label.name === "red-main-watermark"));
    expect(watermarkIssues).toHaveLength(TRACKED_MACOS_JOBS.length);
    expect(watermarkIssues.every((issue) => issue.state === "closed"
      && issue.body?.includes('"outcome":"success"') === true)).toBe(true);
    const writesBeforeLateFailure = api.writes.length;

    api.runs.delete(101);
    const lateRed = run(100, 100, null, "in_progress");
    api.runs.set(100, lateRed);
    api.jobs.set(100, jobFixtures(100, "macos-package-macos-15", "in_progress"));
    const result = await report(api, 100, false);

    expect(result.actions.some((action) => action.kind === "skip"
      && action.jobKey === "macos-package-macos-15"
      && action.detail.includes("persisted outcome #101"))).toBe(true);
    expect(incidentIssues(api)).toHaveLength(0);
    expect(api.writes).toHaveLength(writesBeforeLateFailure);
  });

  test("a stale green outcome cannot overwrite a newer open incident marker", async () => {
    const api = setupFailingRun();
    const newerRed = run(102, 102, null, "in_progress");
    api.runs.set(102, newerRed);
    api.jobs.set(102, jobFixtures(102, "macos-package-macos-15", "in_progress"));
    await report(api, 102, false);
    api.issues.splice(0, api.issues.length, ...api.issues.filter((issue) =>
      !issue.labels.some((label) => label.name === "red-main-watermark")));

    const olderGreen = run(101, 101, "success");
    api.runs.delete(102);
    api.runs.set(101, olderGreen);
    api.jobs.set(101, jobFixtures(101));
    const result = await report(api, 101, false);

    expect(result.actions.some((action) => action.kind === "skip"
      && action.jobKey === "macos-package-macos-15")).toBe(true);
    expect(incidentForJob(api)?.state).toBe("open");
    expect(watermarkForJob(api, "macos-package-macos-15")).toBeUndefined();
  });

  test("reruns recover from lost watermark create and update acknowledgements", async () => {
    const firstJob = TRACKED_MACOS_JOBS[0];
    if (firstJob === undefined) {
      throw new Error("tracked macOS job list must not be empty");
    }
    const green = run(101, 101, "success");
    const api = new MemoryGithubApi(green);
    api.jobs.set(101, jobFixtures(101));
    api.loseNextWatermarkCreateAck = true;
    await expectFailure(report(api, 101, false), "watermark create acknowledgement lost");
    expect(watermarkForJob(api, firstJob.key)?.body).toContain('"runNumber":101');
    await report(api, 101, false);
    expect(api.issues.filter((issue) => issue.labels.some((label) => label.name === "red-main-watermark")
      && issue.labels.some((label) => label.name === jobLabel(firstJob)))).toHaveLength(1);
    const writesAfterRetry = api.writes.length;
    await report(api, 101, false);
    expect(api.writes).toHaveLength(writesAfterRetry);

    const newerGreen = run(102, 102, "success");
    api.runs.set(102, newerGreen);
    api.jobs.set(102, jobFixtures(102));
    api.loseNextWatermarkUpdateAck = true;
    await expectFailure(report(api, 102, false), "watermark update acknowledgement lost");
    expect(watermarkForJob(api, firstJob.key)?.body).toContain('"runNumber":102');
    await report(api, 102, false);
    const writesAfterUpdateRetry = api.writes.length;
    await report(api, 102, false);
    expect(api.writes).toHaveLength(writesAfterUpdateRetry);
  });

  test("serialized failure-green-failure runs reopen one issue with the newest state", async () => {
    const api = setupFailingRun();
    await report(api, 100, false);
    const green = run(101, 101, "success");
    api.runs.set(101, green);
    api.jobs.set(101, jobFixtures(101));
    await report(api, 101, false);
    const newerFailure = run(102, 102, null, "in_progress");
    api.runs.set(102, newerFailure);
    api.jobs.set(102, jobFixtures(102, "macos-package-macos-15", "in_progress"));

    await report(api, 102, false);

    expect(incidentIssues(api)).toHaveLength(1);
    expect(incidentForJob(api)?.state).toBe("open");
    expect(incidentForJob(api)?.body).toContain('"runNumber":102');
    expect(incidentForJob(api)?.body).toContain('"outcome":"failure"');
    expect(watermarkForJob(api, "macos-package-macos-15")?.body).toContain('"runNumber":102');
  });

  test("unavailable ordering history fails closed without issue writes", async () => {
    const api = setupFailingRun();
    api.failHistoryReads = true;

    const result = await report(api, 100, false);

    expect(result.actions.some((action) => action.kind === "skip"
      && action.detail === "latest outcome for this job could not be verified")).toBe(true);
    expect(api.issues).toHaveLength(0);
    expect(api.writes).toHaveLength(0);
    expect(api.historyLimits).toEqual([50]);
  });

  test("older history enrichment failure permits incident without commit range", async () => {
    const api = setupFailingRun();
    api.failedHistoryJobReads.add(90);

    const result = await report(api, 100, false);

    expect(result.actions.some((action) => action.kind === "create")).toBe(true);
    expect(incidentIssues(api)).toHaveLength(1);
    expect(incidentForJob(api)?.body).toContain("History lookup was unavailable; the previous green run could not be determined.");
  });

  test("unavailable newer outcome lookup fails closed", async () => {
    const api = setupFailingRun();
    const newer = run(101, 101, "failure");
    api.runs.set(newer.id, newer);
    api.jobs.set(newer.id, jobFixtures(newer.id));
    api.failedHistoryJobReads.add(newer.id);

    const result = await report(api, 100, false);

    expect(result.actions.some((action) => action.kind === "skip"
      && action.detail === "latest outcome for this job could not be verified")).toBe(true);
    expect(api.issues).toHaveLength(0);
    expect(api.writes).toHaveLength(0);
  });

  test("compare enrichment failure does not prevent incident creation", async () => {
    const api = setupFailingRun();
    api.failCompareReads = true;

    const result = await report(api, 100, false);

    expect(result.actions.some((action) => action.kind === "create")).toBe(true);
    expect(incidentIssues(api)).toHaveLength(1);
    expect(incidentForJob(api)?.body).toContain("Previous green run #90 was found, but compare details are unavailable.");
  });

  test("history job lookups are bounded to the latest fifty runs", async () => {
    const current = run(100, 100, null, "in_progress");
    const history = Array.from({ length: 65 }, (_, index) => run(index + 1, index + 1));
    const api = new MemoryGithubApi(...history, current);
    for (const historic of history) {
      api.jobs.set(historic.id, jobFixtures(historic.id));
    }
    api.jobs.set(100, jobFixtures(100, "macos-package-macos-15", "in_progress"));

    await report(api, 100, false);

    expect(api.historyLimits).toEqual([50]);
    expect(api.historyJobReads).toHaveLength(50);
    expect(api.jobs.size).toBe(66);
  });

  test("dry-run makes no API writes", async () => {
    const api = setupFailingRun();
    const result = await report(api, 100, true);

    expect(result.actions.filter((action) => action.kind === "dry-run")).toHaveLength(1);
    expect(api.writes).toHaveLength(0);
    expect(api.issues).toHaveLength(0);
  });

  test("accepts a scheduled main run when the run and reporter job are still in progress", async () => {
    const api = new MemoryGithubApi(
      run(90, 90, "failure", "completed", "schedule"),
      run(104, 104, null, "in_progress", "schedule"),
    );
    api.jobs.set(90, jobFixtures(90));
    api.jobs.set(104, jobFixtures(104, "macos-package-macos-14", "in_progress"));

    const result = await report(api, 104, false);

    expect(result.actions.some((action) => action.kind === "create"
      && action.jobKey === "macos-package-macos-14")).toBe(true);
    expect(incidentIssues(api)).toHaveLength(1);
  });

  test("main push skips leave an open optional-job incident unchanged", async () => {
    const scheduled = run(100, 100, "success", "completed", "schedule");
    const mainPush = run(101, 101, "success", "completed", "push");
    const api = new MemoryGithubApi(scheduled, mainPush);
    api.jobs.set(100, jobFixtures(100, "macos-package-macos-14"));
    api.jobs.set(101, jobFixtures(101).map((job) => job.name.includes("macos-14")
      || job.name.includes("Hermes compatibility")
      ? { ...job, conclusion: "skipped" }
      : job));

    await report(api, 100, false);
    const greenResult = await report(api, 101, false);

    expect(incidentIssues(api)).toHaveLength(1);
    expect(incidentForJob(api, "macos-package-macos-14")?.state).toBe("open");
    expect(greenResult.actions.some((action) => action.kind === "close")).toBe(false);
  });

  test("scheduled runs reject a skipped required macOS 14 leg before writing", async () => {
    const scheduled = run(100, 100, "success", "completed", "schedule");
    const api = new MemoryGithubApi(scheduled);
    api.jobs.set(100, jobFixtures(100).map((job) => job.name.includes("macos-14")
      ? { ...job, conclusion: "skipped" }
      : job));

    await expectFailure(report(api, 100, false), "skipped required macOS job macos-package-macos-14");
    expect(api.writes).toHaveLength(0);
  });

  test("rejects a run from a different repository before reading jobs or writing", async () => {
    const untrusted = { ...run(100, 100), repository: { full_name: "attacker/pohunek" } };
    const api = new MemoryGithubApi(untrusted);

    let caught: unknown;
    try {
      await report(api, 100, false);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : "").toContain("trusted core repository");
    expect(api.writes).toHaveLength(0);
  });

  test("accepts its own in-progress run only after every tracked macOS job is terminal", async () => {
    const api = setupFailingRun();
    const unfinished = api.jobs.get(100)?.map((job) => job.name === "SDK workspace (macOS arm64)"
      ? { ...job, status: "in_progress", conclusion: null }
      : job);
    if (unfinished === undefined) {
      throw new Error("test fixture is missing run jobs");
    }
    api.jobs.set(100, unfinished);

    await expectFailure(report(api, 100, false), "terminal conclusion");
    expect(api.writes).toHaveLength(0);
  });

  test("rejects a different caller run or job before writing", async () => {
    const api = setupFailingRun();
    await expectFailure(reportCoreRun(api, api, CORE_REPOSITORY, 100, REPORTER_JOB_NAME, {
      dryRun: false,
      callerRunId: 99,
      callerRepository: CORE_REPOSITORY,
      callerSha: api.runs.get(100)?.head_sha ?? "0".repeat(40),
      callerJobName: REPORTER_JOB_NAME,
    }), "current GitHub Actions caller context");
    await expectFailure(reportCoreRun(api, api, CORE_REPOSITORY, 100, "arbitrary-job", {
      dryRun: false,
      callerRunId: 100,
      callerRepository: CORE_REPOSITORY,
      callerSha: api.runs.get(100)?.head_sha ?? "0".repeat(40),
      callerJobName: "arbitrary-job",
    }), "reporter wrapper must run from the red-main-report job");
    await expectFailure(reportCoreRun(api, api, CORE_REPOSITORY, 100, REPORTER_JOB_NAME, {
      dryRun: false,
      callerRunId: 100,
      callerRepository: CORE_REPOSITORY,
      callerSha: "f".repeat(40),
      callerJobName: REPORTER_JOB_NAME,
    }), "head SHA must match");
    expect(api.writes).toHaveLength(0);
  });

  test("Actions reads and issue writes use separate scoped tokens", async () => {
    let authorization = "";
    const writerApi = new GithubRestApi("issues-write-token", (_input, init) => {
      authorization = new Headers(init.headers).get("authorization") ?? "";
      return Promise.resolve(Response.json({ id: 1 }));
    });

    await writerApi.get("repos/zajca/pohunek/issues");
    expect(authorization).toBe("Bearer issues-write-token");

    const readerApi = new GithubRestApi("actions-read-token", (_input, init) => {
      authorization = new Headers(init.headers).get("authorization") ?? "unset";
      return Promise.resolve(Response.json({ id: 1 }));
    });
    await readerApi.get("repos/zajca/pohunek/actions/runs/1");
    expect(authorization).toBe("Bearer actions-read-token");
  });
});

async function expectFailure(operation: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught instanceof Error ? caught.message : "").toContain(message);
}
