import { CORE_REPOSITORY } from "./config.ts";
import { GithubRestApi } from "./github.ts";
import { reportCoreRun } from "./reporter.ts";

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

async function main(): Promise<void> {
  const runId = argument("--run-id");
  if (runId === undefined || !/^\d+$/.test(runId)) {
    throw new Error("--run-id must be a positive GitHub Actions run ID");
  }
  const repository = argument("--repository");
  const callerRepository = argument("--caller-repository");
  if (repository !== CORE_REPOSITORY || callerRepository !== repository) {
    throw new Error(`--repository must be ${CORE_REPOSITORY}`);
  }
  const callerRunId = argument("--caller-run-id");
  if (callerRunId === undefined || !/^\d+$/.test(callerRunId) || callerRunId !== runId) {
    throw new Error("--caller-run-id must equal the current GitHub Actions run ID");
  }
  const callerSha = argument("--caller-sha");
  if (callerSha === undefined || !/^[0-9a-f]{40}$/i.test(callerSha)) {
    throw new Error("--caller-sha must be the current GitHub Actions commit SHA");
  }
  const callerJobName = argument("--caller-job-name");
  if (callerJobName === undefined) {
    throw new Error("--caller-job-name is required");
  }
  const token = process.env["GITHUB_TOKEN"];
  if (token === undefined) {
    throw new Error("GITHUB_TOKEN is required");
  }
  const readApi = new GithubRestApi();
  const issueApi = new GithubRestApi(token);
  const result = await reportCoreRun(readApi, issueApi, repository, Number(runId), callerJobName, {
    dryRun: Bun.argv.includes("--dry-run"),
    callerRunId: Number(callerRunId),
    callerRepository,
    callerSha,
    callerJobName,
  });
  for (const action of result.actions) {
    console.log(`${action.kind}: ${action.jobKey} ${action.detail}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unexpected error";
  console.error(`red-main reporter failed: ${message}`);
  process.exitCode = 1;
});
