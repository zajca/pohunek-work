import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORE_REPOSITORY, COLLECTOR_JOB_NAME, REPORTER_JOB_NAME, TRACKED_MACOS_JOBS, jobLabel } from "../src/config.ts";

interface ActionStep {
  readonly uses?: string;
  readonly shell?: string;
  readonly run?: string;
}

interface CompositeAction {
  readonly runs: { readonly using: string; readonly steps: readonly ActionStep[] };
}

interface TestIssue {
  readonly number: number;
  title: string;
  body: string | null;
  state: string;
  labels: readonly { readonly name: string }[];
}

interface ApiCall {
  readonly method: string;
  readonly pathname: string;
  readonly body: Record<string, unknown> | undefined;
  readonly authorization: string;
}

interface FixtureState {
  run: ReturnType<typeof runRecord>;
  jobs: ReturnType<typeof jobRecords>;
  readonly calls: ApiCall[];
  readonly issues: TestIssue[];
  readonly labels: string[];
  readonly comments: Record<string, { body: string }[]>;
  loseWatermarkCreateAck: boolean;
  loseWatermarkUpdateAck: boolean;
  nextIssueNumber: number;
}

const RUN_ID = 100;
const RUN_SHA = "a".repeat(40);
const BUN_PATH = process.execPath;
const REPORTER_ROOT = resolve(import.meta.dir, "..");
const ACTION_PATH = join(REPORTER_ROOT, "action.yml");
const SETUP_BUN_SHA = "0c5077e51419868618aeaa5fe8019c62421857d6";

function runRecord(id: number, runNumber: number, status: "in_progress" | "completed"): Record<string, unknown> {
  return {
    id,
    run_number: runNumber,
    run_attempt: 1,
    event: "push",
    head_branch: "main",
    head_sha: RUN_SHA,
    status,
    conclusion: status === "completed" ? "success" : null,
    path: ".github/workflows/ci.yml@refs/heads/main",
    html_url: `https://github.com/${CORE_REPOSITORY}/actions/runs/${id}`,
    repository: { full_name: CORE_REPOSITORY },
    head_repository: { full_name: CORE_REPOSITORY },
  };
}

function jobRecords(
  runId: number,
  reporterStatus: "in_progress" | "completed",
  failing = true,
): Record<string, unknown>[] {
  const tracked = TRACKED_MACOS_JOBS.map((job, index) => ({
    id: runId * 10 + index,
    run_id: runId,
    name: job.name,
    status: "completed",
    conclusion: failing && job.key === "macos-package-macos-15" ? "failure" : "success",
    html_url: `https://github.com/${CORE_REPOSITORY}/actions/runs/${runId}/job/${runId * 10 + index}`,
    run_url: `https://api.github.com/repos/${CORE_REPOSITORY}/actions/runs/${runId}`,
    steps: [
      { name: "checkout", conclusion: "success" },
      {
        name: failing && job.key === "macos-package-macos-15" ? "Package install acceptance" : "test",
        conclusion: failing && job.key === "macos-package-macos-15" ? "failure" : "success",
      },
    ],
  }));
  return [
    ...tracked,
    {
      id: runId * 10 + tracked.length,
      run_id: runId,
      name: REPORTER_JOB_NAME,
      status: reporterStatus,
      conclusion: reporterStatus === "completed" ? "success" : null,
      html_url: `https://github.com/${CORE_REPOSITORY}/actions/runs/${runId}/job/reporter`,
      run_url: `https://api.github.com/repos/${CORE_REPOSITORY}/actions/runs/${runId}`,
      steps: [],
    },
    {
      id: runId * 10 + tracked.length + 1,
      run_id: runId,
      name: COLLECTOR_JOB_NAME,
      status: reporterStatus,
      conclusion: reporterStatus === "completed" ? "success" : null,
      html_url: `https://github.com/${CORE_REPOSITORY}/actions/runs/${runId}/job/collector`,
      run_url: `https://api.github.com/repos/${CORE_REPOSITORY}/actions/runs/${runId}`,
      steps: [],
    },
  ];
}

class GithubFixture {
  public readonly statePath: string;

  public constructor(statePath: string) {
    this.statePath = statePath;
  }

  public async read(): Promise<FixtureState> {
    return JSON.parse(await readFile(this.statePath, "utf8")) as FixtureState;
  }

  public async setLoseWatermarkCreateAck(value: boolean): Promise<void> {
    const state = await this.read();
    state.loseWatermarkCreateAck = value;
    await writeFile(this.statePath, JSON.stringify(state));
  }

  public async setLoseWatermarkUpdateAck(value: boolean): Promise<void> {
    const state = await this.read();
    state.loseWatermarkUpdateAck = value;
    await writeFile(this.statePath, JSON.stringify(state));
  }

  public async setGreenRun(): Promise<void> {
    const state = await this.read();
    state.run = runRecord(RUN_ID + 1, RUN_ID + 1, "in_progress");
    state.jobs = jobRecords(RUN_ID + 1, "in_progress", false);
    await writeFile(this.statePath, JSON.stringify(state));
  }
}

interface Harness {
  readonly fixture: GithubFixture;
  readonly runStep: (overrides?: Partial<Record<string, string>>) => Promise<{
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly outputPath: string;
  readonly snapshot: () => Promise<string>;
  readonly root: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pohunek-ci-reporter-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const statePath = join(root, "api-state.json");
  await writeFile(statePath, JSON.stringify({
    run: runRecord(RUN_ID, RUN_ID, "in_progress"),
    jobs: jobRecords(RUN_ID, "in_progress"),
    calls: [],
    issues: [],
    labels: [],
    comments: {},
    loseWatermarkCreateAck: false,
    loseWatermarkUpdateAck: false,
    nextIssueNumber: 1,
  } satisfies FixtureState));
  const fixture = new GithubFixture(statePath);
  const preloadPath = join(REPORTER_ROOT, "tests/fixtures/github-fetch.ts");
  await writeFile(join(bin, "bun"), `#!/bin/sh\nexec ${shellQuote(BUN_PATH)} --preload ${shellQuote(preloadPath)} "$@"\n`);
  await Bun.$`chmod 700 ${join(bin, "bun")}`;
  const outputPath = join(root, "github-output");
  const action = Bun.YAML.parse(await readFile(ACTION_PATH, "utf8")) as CompositeAction;
  const shellStep = action.runs.steps.find((step) => step.shell === "bash" && step.run !== undefined);
  if (shellStep?.run === undefined) {
    throw new Error("reporter action shell step is missing");
  }
  const runScript = shellStep.run;
  return {
    fixture,
    outputPath,
    root,
    snapshot: async () => {
      const output = await readFile(outputPath, "utf8");
      const matches = [...output.matchAll(/^snapshot<<[^\n]+\n([\s\S]*?)\n[^\n]+\n/gm)];
      const snapshot = matches.at(-1)?.[1];
      if (snapshot === undefined) {
        throw new Error("action did not write a snapshot output");
      }
      return snapshot;
    },
    runStep: async (overrides = {}) => {
      const mode = overrides["MODE"] ?? "collect";
      const environment: Record<string, string> = {
        ...process.env as Record<string, string>,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_TOKEN: mode === "report" ? "issue-write-token" : "",
        ACTIONS_READ_TOKEN: mode === "collect" ? "actions-read-token" : "",
        REPORT_SNAPSHOT: "",
        MODE: "collect",
        RUN_ID: String(RUN_ID),
        REPOSITORY: CORE_REPOSITORY,
        CALLER_JOB_NAME: COLLECTOR_JOB_NAME,
        DRY_RUN: "false",
        REPORTER_PATH: REPORTER_ROOT,
        CALLER_RUN_ID: String(RUN_ID),
        CALLER_REPOSITORY: CORE_REPOSITORY,
        CALLER_SHA: RUN_SHA,
        REPORTER_TEST_STATE: fixture.statePath,
        ...overrides,
      };
      const child = Bun.spawn(["bash", "--noprofile", "--norc", "-e", "-c", runScript], {
        cwd: REPORTER_ROOT,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { status, stdout, stderr };
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function closeHarness(harness: Harness): Promise<void> {
  await rm(harness.root, { recursive: true, force: true });
}

const activeHarnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map(closeHarness));
});

async function harness(): Promise<Harness> {
  const current = await createHarness();
  activeHarnesses.push(current);
  return current;
}

describe("red-main reporter action boundary", () => {
  test("pins setup-bun and carries a collected snapshot through action output into issue reporting", async () => {
    const action = Bun.YAML.parse(await readFile(ACTION_PATH, "utf8")) as CompositeAction;
    expect(action.runs.using).toBe("composite");
    expect(action.runs.steps[0]?.uses).toBe(`oven-sh/setup-bun@${SETUP_BUN_SHA}`);

    const current = await harness();
    const collection = await current.runStep();
    expect(collection.status).toBe(0);
    expect(collection.stdout).toContain("collected verified CI snapshot");
    const collected = await current.snapshot();
    expect(new TextEncoder().encode(collected).byteLength).toBeLessThan(64 * 1024);
    expect(collected).not.toContain("raw_logs");
    const collectionState = await current.fixture.read();
    expect(collectionState.calls.every((call) => call.authorization === "Bearer actions-read-token")).toBe(true);

    const reportStart = collectionState.calls.length;
    const report = await current.runStep({
      MODE: "report",
      CALLER_JOB_NAME: REPORTER_JOB_NAME,
      REPORT_SNAPSHOT: collected,
    });
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("create: macos-package-macos-15");
    const state = await current.fixture.read();
    expect(state.issues.filter((issue) => issue.labels.some((label) =>
      label.name === "red-main-incident"))).toHaveLength(1);
    expect(state.issues.some((issue) => issue.labels.some((label) =>
      label.name === "red-main-watermark"))).toBe(true);
    expect(state.calls.some((call) => call.method === "GET"
      && call.pathname.includes("/actions/runs/100/jobs"))).toBe(true);
    expect(state.calls.some((call) => call.method === "POST"
      && call.pathname.endsWith("/issues"))).toBe(true);
    expect(state.calls.slice(reportStart).every((call) => call.authorization === "Bearer issue-write-token")).toBe(true);
  });

  test("dry-run is read-only and caller identity or snapshot size failures stop at the CLI boundary", async () => {
    const current = await harness();
    const collection = await current.runStep();
    expect(collection.status).toBe(0);
    const collected = await current.snapshot();
    const stateBefore = await current.fixture.read();
    stateBefore.calls.splice(0);
    await writeFile(current.fixture.statePath, JSON.stringify(stateBefore));

    const dryRun = await current.runStep({
      MODE: "report",
      CALLER_JOB_NAME: REPORTER_JOB_NAME,
      DRY_RUN: "true",
      REPORT_SNAPSHOT: collected,
    });
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("dry-run: macos-package-macos-15");
    let state = await current.fixture.read();
    expect(state.calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(false);
    expect(state.issues).toHaveLength(0);

    await writeFile(current.outputPath, "");
    const mismatchedIdentity = await current.runStep({ CALLER_SHA: "b".repeat(40) });
    expect(mismatchedIdentity.status).toBe(1);
    expect(mismatchedIdentity.stderr).toContain("run head SHA must match");
    expect(await Bun.file(current.outputPath).text()).toBe("");

    const mismatchedSnapshot = JSON.stringify({ ...JSON.parse(collected), collectorSha: "c".repeat(40) });
    const rejectedIdentity = await current.runStep({
      MODE: "report",
      CALLER_JOB_NAME: REPORTER_JOB_NAME,
      REPORT_SNAPSHOT: mismatchedSnapshot,
    });
    expect(rejectedIdentity.status).toBe(1);
    expect(rejectedIdentity.stderr).toContain("does not match the trusted current caller context");

    const oversizedSnapshot = await current.runStep({
      MODE: "report",
      CALLER_JOB_NAME: REPORTER_JOB_NAME,
      REPORT_SNAPSHOT: "x".repeat(64 * 1024 + 1),
    });
    expect(oversizedSnapshot.status).toBe(1);
    expect(oversizedSnapshot.stderr).toContain("REPORT_SNAPSHOT is missing or exceeds 65536 bytes");
    state = await current.fixture.read();
    expect(state.calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(false);
  });

  test("a retry recovers after the server applies a watermark create but loses its acknowledgement", async () => {
    const current = await harness();
    const collection = await current.runStep();
    expect(collection.status).toBe(0);
    const collected = await current.snapshot();
    await current.fixture.setLoseWatermarkCreateAck(true);

    const firstAttempt = await current.runStep({
      MODE: "report",
      CALLER_JOB_NAME: REPORTER_JOB_NAME,
      REPORT_SNAPSHOT: collected,
    });
    expect(firstAttempt.status).toBe(1);
    expect(firstAttempt.stderr).toContain("GitHub API POST request failed with status 500");

    const retry = await current.runStep({
      MODE: "report",
      CALLER_JOB_NAME: REPORTER_JOB_NAME,
      REPORT_SNAPSHOT: collected,
    });
    expect(retry.status).toBe(0);
    const state = await current.fixture.read();
    expect(state.issues.filter((issue) => issue.labels.some((label) =>
      label.name === "red-main-incident"))).toHaveLength(1);
    const failedJob = TRACKED_MACOS_JOBS.find((job) => job.key === "macos-package-macos-15");
    if (failedJob === undefined) {
      throw new Error("tracked macOS package job must exist");
    }
    expect(state.issues.filter((issue) => issue.labels.some((label) =>
      label.name === "red-main-watermark") && issue.labels.some((label) =>
      label.name === jobLabel(failedJob)))).toHaveLength(1);
    expect(retry.stdout).toContain("skip: macos-package-macos-15");

    await current.fixture.setGreenRun();
    const greenCollection = await current.runStep({
      RUN_ID: String(RUN_ID + 1),
      CALLER_RUN_ID: String(RUN_ID + 1),
    });
    expect(greenCollection.status).toBe(0);
    const greenSnapshot = await current.snapshot();
    await current.fixture.setLoseWatermarkUpdateAck(true);

    const failedUpdate = await current.runStep({
      MODE: "report",
      RUN_ID: String(RUN_ID + 1),
      CALLER_RUN_ID: String(RUN_ID + 1),
      CALLER_JOB_NAME: REPORTER_JOB_NAME,
      REPORT_SNAPSHOT: greenSnapshot,
    });
    expect(failedUpdate.status).toBe(1);
    expect(failedUpdate.stderr).toContain("GitHub API PATCH request failed with status 500");

    const recoveredUpdate = await current.runStep({
      MODE: "report",
      RUN_ID: String(RUN_ID + 1),
      CALLER_RUN_ID: String(RUN_ID + 1),
      CALLER_JOB_NAME: REPORTER_JOB_NAME,
      REPORT_SNAPSHOT: greenSnapshot,
    });
    expect(recoveredUpdate.status).toBe(0);
    const updatedState = await current.fixture.read();
    const targetWatermarks = updatedState.issues.filter((issue) =>
      issue.labels.some((label) => label.name === "red-main-watermark")
      && issue.labels.some((label) => label.name === jobLabel(failedJob)));
    expect(targetWatermarks).toHaveLength(1);
    expect(targetWatermarks[0]?.body).toContain('"runNumber":101');
    expect(updatedState.issues.filter((issue) => issue.labels.some((label) =>
      label.name === "red-main-incident") && issue.labels.some((label) =>
      label.name === jobLabel(failedJob)))).toHaveLength(1);
  });
});
