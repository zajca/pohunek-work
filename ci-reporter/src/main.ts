import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { COLLECTOR_JOB_NAME, CORE_REPOSITORY, REPORTER_JOB_NAME } from "./config.ts";
import { GithubRestApi } from "./github.ts";
import { collectCoreRun, reportCollectedSnapshot, type CollectedSnapshot } from "./reporter.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = argument("--mode");
  const runId = requiredArgument("--run-id");
  if (!/^\d+$/.test(runId) || Number(runId) < 1) {
    throw new Error("--run-id must be a positive GitHub Actions run ID");
  }
  const repository = requiredArgument("--repository");
  const callerRepository = requiredArgument("--caller-repository");
  const callerRunId = requiredArgument("--caller-run-id");
  const callerSha = requiredArgument("--caller-sha");
  const callerJobName = requiredArgument("--caller-job-name");
  if (repository !== CORE_REPOSITORY || callerRepository !== repository || callerRunId !== runId) {
    throw new Error(`repository and run identity must match ${CORE_REPOSITORY} caller context`);
  }
  if (!/^[0-9a-f]{40}$/i.test(callerSha)) {
    throw new Error("--caller-sha must be the current GitHub Actions commit SHA");
  }

  if (mode === "collect") {
    if (callerJobName !== COLLECTOR_JOB_NAME) {
      throw new Error(`collect mode must run from the ${COLLECTOR_JOB_NAME} job`);
    }
    const token = process.env["ACTIONS_READ_TOKEN"];
    if (token === undefined) {
      throw new Error("ACTIONS_READ_TOKEN is required in collect mode");
    }
    const snapshot = await collectCoreRun(
      new GithubRestApi(token),
      repository,
      Number(runId),
      {
        callerRunId: Number(callerRunId),
        callerRepository,
        callerSha,
        callerJobName,
      },
      new GithubRestApi(),
    );
    await writeOutput("snapshot", JSON.stringify(snapshot));
    console.log(`collected verified CI snapshot (${snapshot.history.length} history runs, complete=${snapshot.historyComplete})`);
    return;
  }

  if (mode === "report") {
    if (callerJobName !== REPORTER_JOB_NAME) {
      throw new Error(`report mode must run from the ${REPORTER_JOB_NAME} job`);
    }
    const token = process.env["GITHUB_TOKEN"];
    if (token === undefined) {
      throw new Error("GITHUB_TOKEN is required in report mode");
    }
    const serialized = process.env["REPORT_SNAPSHOT"];
    if (serialized === undefined || new TextEncoder().encode(serialized).length > MAX_OUTPUT_BYTES) {
      throw new Error(`REPORT_SNAPSHOT is missing or exceeds ${MAX_OUTPUT_BYTES} bytes`);
    }
    let snapshot: CollectedSnapshot;
    try {
      snapshot = JSON.parse(serialized) as CollectedSnapshot;
    } catch {
      throw new Error("REPORT_SNAPSHOT is not valid JSON");
    }
    const result = await reportCollectedSnapshot(new GithubRestApi(token), snapshot, {
      dryRun: Bun.argv.includes("--dry-run"),
      callerRunId: Number(callerRunId),
      callerRepository,
      callerSha,
      callerJobName,
    });
    for (const action of result.actions) {
      console.log(`${action.kind}: ${action.jobKey} ${action.detail}`);
    }
    return;
  }

  throw new Error("--mode must be collect or report");
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function writeOutput(name: string, value: string): Promise<void> {
  const outputPath = process.env["GITHUB_OUTPUT"];
  if (outputPath === undefined) {
    throw new Error("GITHUB_OUTPUT is required in collect mode");
  }
  if (new TextEncoder().encode(value).length > MAX_OUTPUT_BYTES || value.includes("\n")) {
    throw new Error(`workflow output ${name} exceeds its size limit or contains a newline`);
  }
  const delimiter = `REPORTER_${randomUUID().replaceAll("-", "")}`;
  await appendFile(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unexpected error";
  console.error(`red-main reporter failed: ${message}`);
  process.exitCode = 1;
});
