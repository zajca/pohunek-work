import { describe, expect, test } from "bun:test";
import { CORE_REPOSITORY, TRACKED_MACOS_JOBS, jobLabel, ISSUE_LABEL, REPORTER_JOB_NAME } from "../src/config.ts";
import { GithubRestApi, type GithubApi, type JsonObject } from "../src/github.ts";
import { reportCoreRun, type ReporterResult } from "../src/reporter.ts";

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
  public failNextClosePatch = false;
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
      return Promise.resolve({
        html_url: `https://github.com/${CORE_REPOSITORY}/compare/${comparePath}`,
        total_commits: 7,
      } as T);
    }
    throw new Error(`unexpected GET ${path}`);
  }

  public getAll<T>(path: string): Promise<readonly T[]> {
    const runId = /actions\/runs\/(\d+)\/jobs/.exec(path)?.[1];
    if (runId !== undefined) {
      return Promise.resolve((this.jobs.get(Number(runId)) ?? []) as T[]);
    }
    const issueComments = /issues\/(\d+)\/comments/.exec(path)?.[1];
    if (issueComments !== undefined) {
      return Promise.resolve((this.comments.get(Number(issueComments)) ?? []) as T[]);
    }
    if (path.endsWith("/labels?per_page=100")) {
      return Promise.resolve([...this.labels].map((name) => ({ name })) as T[]);
    }
    if (path.includes("/issues?state=open&labels=")) {
      const labelsValue = new URLSearchParams(path.split("?")[1]).get("labels");
      const wanted = labelsValue?.split(",") ?? [];
      return Promise.resolve(this.issues.filter((issue) => issue.state === "open"
        && wanted.every((name) => issue.labels.some((label) => label.name === name))) as T[]);
    }
    throw new Error(`unexpected GET all ${path}`);
  }

  public getAllFrom<T>(path: string, collectionKey: string): Promise<readonly T[]> {
    if (collectionKey !== "workflow_runs") {
      throw new Error(`unexpected collection key ${collectionKey}`);
    }
    const before = Number(new URLSearchParams(path.split("?")[1]).get("before") ?? Number.MAX_SAFE_INTEGER);
    return Promise.resolve([...this.runs.values()]
      .filter((run) => run.run_number < before)
      .sort((left, right) => right.run_number - left.run_number) as T[]);
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
      return Promise.resolve(issue as T);
    }
    throw new Error(`unexpected POST ${path}`);
  }

  public patch<T>(path: string, body: JsonObject): Promise<T> {
    if (body["state"] === "closed" && this.failNextClosePatch) {
      this.failNextClosePatch = false;
      return Promise.reject(new Error("temporary patch failure"));
    }
    this.writes.push({ method: "PATCH", path, body });
    const issueNumber = /issues\/(\d+)$/.exec(path)?.[1];
    const issue = this.issues.find((item) => item.number === Number(issueNumber));
    if (issue === undefined) {
      throw new Error(`unexpected PATCH ${path}`);
    }
    if (typeof body["body"] === "string") {
      issue.body = body["body"];
    }
    if (typeof body["state"] === "string") {
      issue.state = body["state"];
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

describe("red-main incident reporter", () => {
  test("creates one labeled issue with failing step, run link and range from the last green job run", async () => {
    const api = setupFailingRun();
    const result = await report(api, 100, false);

    expect(result.actions).toContainEqual({
      kind: "create",
      jobKey: "macos-package-macos-15",
      detail: "created issue #1",
    });
    expect(api.issues).toHaveLength(1);
    expect(api.issues[0]?.labels.map((label) => label.name)).toEqual([
      ISSUE_LABEL,
      jobLabel(TRACKED_MACOS_JOBS.find((job) => job.key === "macos-package-macos-15") ?? {
        key: "missing",
        name: "missing",
      }),
    ]);
    expect(api.issues[0]?.body).toContain("Package install acceptance");
    expect(api.issues[0]?.body).toContain("actions/runs/100");
    expect(api.issues[0]?.body).toContain("(7 commits)");
    expect(api.issues[0]?.body).toContain("/compare/000000000000000000000000000000000000005a...0000000000000000000000000000000000000064");
    expect(api.comparisons).toEqual([
      "000000000000000000000000000000000000005a...0000000000000000000000000000000000000064",
    ]);
  });

  test("duplicate delivery does not create a second issue or write again", async () => {
    const api = setupFailingRun();
    await report(api, 100, false);
    const writeCount = api.writes.length;
    const duplicate = await report(api, 100, false);

    expect(api.issues).toHaveLength(1);
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
    expect(api.issues[0]?.state).toBe("open");

    const laterGreen = run(103, 103, "success");
    api.runs.set(103, laterGreen);
    api.jobs.set(103, jobFixtures(103));
    api.failNextClosePatch = true;
    await expectFailure(report(api, 103, false), "temporary patch failure");
    expect(api.comments.get(1)?.filter((comment) => comment.body.includes("actions/runs/103"))).toHaveLength(1);
    const closeResult = await report(api, 103, false);
    expect(closeResult.actions.some((action) => action.kind === "close")).toBe(true);
    expect(api.issues[0]?.state).toBe("closed");
    expect(api.comments.get(1)?.some((comment) => comment.body.includes("actions/runs/103"))).toBe(true);
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
    expect(api.issues).toHaveLength(1);
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
    }), "reporter must run");
    await expectFailure(reportCoreRun(api, api, CORE_REPOSITORY, 100, REPORTER_JOB_NAME, {
      dryRun: false,
      callerRunId: 100,
      callerRepository: CORE_REPOSITORY,
      callerSha: "f".repeat(40),
      callerJobName: REPORTER_JOB_NAME,
    }), "head SHA must match");
    expect(api.writes).toHaveLength(0);
  });

  test("API requests authenticate with the supplied scoped token", async () => {
    let authorization = "";
    const api = new GithubRestApi("scoped-token", (_input, init) => {
      authorization = new Headers(init.headers).get("authorization") ?? "";
      return Promise.resolve(Response.json({ id: 1 }));
    });

    await api.get("repos/zajca/pohunek/issues");
    expect(authorization).toBe("Bearer scoped-token");

    authorization = "unset";
    const publicApi = new GithubRestApi(undefined, (_input, init) => {
      authorization = new Headers(init.headers).get("authorization") ?? "unset";
      return Promise.resolve(Response.json({ id: 1 }));
    });
    await publicApi.get("repos/zajca/pohunek/actions/runs/1");
    expect(authorization).toBe("unset");
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
