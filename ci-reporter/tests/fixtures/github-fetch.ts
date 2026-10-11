import { readFile, writeFile } from "node:fs/promises";

interface FixtureIssue {
  readonly number: number;
  title: string;
  body: string | null;
  state: string;
  readonly labels: readonly { readonly name: string }[];
}

interface FixtureState {
  readonly run: Record<string, unknown>;
  readonly jobs: readonly Record<string, unknown>[];
  readonly calls: {
    readonly method: string;
    readonly pathname: string;
    readonly body: Record<string, unknown> | undefined;
    readonly authorization: string;
  }[];
  readonly issues: FixtureIssue[];
  readonly labels: string[];
  readonly comments: Record<string, { body: string }[]>;
  loseWatermarkCreateAck: boolean;
  loseWatermarkUpdateAck: boolean;
  nextIssueNumber: number;
}

const statePath = process.env["REPORTER_TEST_STATE"];
if (statePath === undefined) {
  throw new Error("REPORTER_TEST_STATE is required by the hermetic reporter transport fixture");
}

Object.defineProperty(globalThis, "fetch", {
  value: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://api.github.com") {
    throw new Error("reporter attempted to contact a non-GitHub API origin");
  }
  const method = request.method;
  const body = method === "POST" || method === "PATCH"
    ? await request.json() as Record<string, unknown>
    : undefined;
  const state = JSON.parse(await readFile(statePath, "utf8")) as FixtureState;
  const pathname = url.pathname + url.search;
  (state.calls as {
    method: string;
    pathname: string;
    body: Record<string, unknown> | undefined;
    authorization: string;
  }[])
    .push({ method, pathname, body, authorization: request.headers.get("authorization") ?? "" });

  let responseBody: unknown;
  let status = 200;
  const repositoryPath = "/repos/zajca/pohunek";
  if (url.pathname === `${repositoryPath}/actions/runs/${String(state.run["id"])}` && method === "GET") {
    responseBody = state.run;
  } else if (url.pathname === `${repositoryPath}/actions/runs/${String(state.run["id"])}/jobs` && method === "GET") {
    responseBody = { jobs: state.jobs };
  } else if (url.pathname === `${repositoryPath}/actions/workflows/ci.yml/runs` && method === "GET") {
    responseBody = { workflow_runs: [] };
  } else if (url.pathname === `${repositoryPath}/labels` && method === "GET") {
    responseBody = state.labels.map((name) => ({ name }));
  } else if (url.pathname === `${repositoryPath}/labels` && method === "POST") {
    const name = String(body?.["name"]);
    if (!state.labels.includes(name)) {
      state.labels.push(name);
    }
    responseBody = { name };
    status = 201;
  } else if (url.pathname === `${repositoryPath}/issues` && method === "GET") {
    const wanted = url.searchParams.get("labels")?.split(",") ?? [];
    const matches = state.issues.filter((issue) =>
      wanted.every((label) => issue.labels.some((candidate) => candidate.name === label)));
    responseBody = matches;
  } else if (url.pathname === `${repositoryPath}/issues` && method === "POST") {
    const issue: FixtureIssue = {
      number: state.nextIssueNumber++,
      title: String(body?.["title"]),
      body: typeof body?.["body"] === "string" ? body["body"] : null,
      state: "open",
      labels: (body?.["labels"] as string[]).map((name) => ({ name })),
    };
    state.issues.push(issue);
    responseBody = issue;
    status = 201;
    if (issue.labels.some((label) => label.name === "red-main-watermark")
      && issue.labels.some((label) => label.name === "red-main-macos-package-macos-15")
      && state.loseWatermarkCreateAck) {
      state.loseWatermarkCreateAck = false;
      responseBody = { message: "acknowledgement lost" };
      status = 500;
    }
  } else {
    const comments = /\/issues\/(\d+)\/comments$/.exec(url.pathname)?.[1];
    const issueNumber = /\/issues\/(\d+)$/.exec(url.pathname)?.[1];
    if (comments !== undefined && method === "GET") {
      responseBody = state.comments[comments] ?? [];
    } else if (comments !== undefined && method === "POST") {
      const records = state.comments[comments] ?? [];
      records.push({ body: String(body?.["body"]) });
      state.comments[comments] = records;
      responseBody = {};
      status = 201;
    } else if (issueNumber !== undefined && method === "PATCH") {
      const issue = state.issues.find((candidate) => candidate.number === Number(issueNumber));
      if (issue === undefined) {
        responseBody = { message: "not found" };
        status = 404;
      } else {
        if (typeof body?.["body"] === "string") {
          issue.body = body["body"];
        }
        if (typeof body?.["state"] === "string") {
          issue.state = body["state"];
        }
        responseBody = issue;
        if (issue.labels.some((label) => label.name === "red-main-watermark")
          && issue.labels.some((label) => label.name === "red-main-macos-package-macos-15")
          && state.loseWatermarkUpdateAck) {
          state.loseWatermarkUpdateAck = false;
          responseBody = { message: "acknowledgement lost" };
          status = 500;
        }
      }
    } else {
      responseBody = { message: `unexpected ${method} ${url.pathname}` };
      status = 404;
    }
  }
  await writeFile(statePath, JSON.stringify(state));
  return Response.json(responseBody, { status });
  },
});
