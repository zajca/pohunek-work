import { expect, test } from "bun:test";
import { createLinearSource } from "../../src/sources/linear.ts";
import type { LinearConfig, LinearProject } from "../../src/types/config.ts";
import type { Exec } from "../../src/util/exec.ts";

const FAKE = "fake-token-not-real";
const config: LinearConfig = {
  endpoint: "https://linear.example/graphql",
  secretToolBin: "/usr/bin/secret-tool-fake",
  keyringService: "svc-fake",
  keyringKey: "key-fake",
  timeoutMs: 500,
  pageSize: 1,
};
const project = { name: "widgets", issueSource: { kind: "linear", team: "ABC", pausedStates: [] }, ignoreLabel: null } as unknown as LinearProject;

async function fixture(name: string): Promise<unknown> {
  return (await Bun.file(new URL(`../fixtures/linear/${name}.json`, import.meta.url)).json()) as unknown;
}

interface Call {
  readonly headers: Record<string, string>;
  readonly body: { query: string; variables: Record<string, unknown> };
}

const goodExec: Exec = () => Promise.resolve({ exitCode: 0, stdout: `${FAKE}\n`, stderr: "", timedOut: false });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fetcher(handler: (call: Call, index: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (_url: unknown, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(init?.body as string) as Call["body"],
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function source(f: typeof fetch, exec: Exec = goodExec): ReturnType<typeof createLinearSource> {
  return createLinearSource(config, { exec, fetch: f });
}

async function expectFailure(
  f: typeof fetch,
  code: string,
  exec: Exec = goodExec,
): Promise<string> {
  const result = await source(f, exec).fetchIssues(project);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected failure");
  }
  expect(result.code).toBe(code as typeof result.code);
  expect(result.source).toBe("linear");
  expect(result.message).not.toContain(FAKE);
  return result.message;
}

test("normalizes issues across two pages, with attachment URLs", async () => {
  const pages = [await fixture("page1"), await fixture("page2")];
  const { fetch: f, calls } = fetcher((_c, i) => json(pages[i]));
  const result = await source(f).fetchIssues(project);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.data).toEqual([
    {
      id: "ABC-1",
      title: "Add widget cache",
      url: "https://linear.example/acme/issue/ABC-1",
      state: "In Progress",
      started: true,
      paused: false,
      assigneeIsMe: true,
      attachmentUrls: ["https://github.com/acme/widgets/pull/12"],
      ignored: false,
    },
    {
      id: "ABC-2",
      title: "Fix widget layout",
      url: "https://linear.example/acme/issue/ABC-2",
      state: "In Review",
      started: true,
      paused: false,
      assigneeIsMe: true,
      attachmentUrls: [],
      ignored: false,
    },
  ]);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.body.variables).toEqual({ first: 1, after: null, teamKey: "ABC", attachmentsFirst: 1 });
  expect(calls[1]?.body.variables["after"]).toBe("cursor-1");
  expect(calls[0]?.body.query).toContain("isMe: { eq: true }");
  expect(calls[0]?.body.query).toContain('type: { eq: "started" }');
  expect(calls[0]?.body.query.trimStart().startsWith("query")).toBe(true);
});

test("sends the raw token in the Authorization header", async () => {
  const { fetch: f, calls } = fetcher(() => json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
  const result = await source(f).fetchIssues(project);
  expect(result.ok).toBe(true);
  expect(calls[0]?.headers["Authorization"]).toBe(FAKE);
});

test("passes the exact secret-tool argv and no token in it", async () => {
  const argvs: (readonly string[])[] = [];
  const exec: Exec = (argv) => {
    argvs.push(argv);
    return goodExec(argv, { timeoutMs: 1 });
  };
  const { fetch: f } = fetcher(() => json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
  await source(f, exec).fetchIssues(project);
  expect(argvs).toEqual([
    ["/usr/bin/secret-tool-fake", "lookup", "service", "svc-fake", "username", "key-fake"],
  ]);
  expect(JSON.stringify(argvs)).not.toContain(FAKE);
});

test("follows attachment pagination for an issue", async () => {
  const responses = [await fixture("attachments-more"), await fixture("attachments-page2")];
  const { fetch: f, calls } = fetcher((_c, i) => json(responses[i]));
  const result = await source(f).fetchIssues(project);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.data[0]?.attachmentUrls).toEqual([
    "https://github.com/acme/widgets/pull/30",
    "https://github.com/acme/widgets/pull/31",
  ]);
  expect(calls[1]?.body.variables).toEqual({
    id: "00000000-0000-0000-0000-000000000003",
    first: 1,
    after: "att-1",
  });
});

test("repeated issue cursor is truncated", async () => {
  const page1 = await fixture("page1");
  const { fetch: f } = fetcher(() => json(page1));
  await expectFailure(f, "truncated");
});

test("missing cursor with hasNextPage is truncated", async () => {
  const { fetch: f } = fetcher(() =>
    json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } }),
  );
  await expectFailure(f, "truncated");
});

test("attachment pagination without a cursor is truncated", async () => {
  const page = (await fixture("attachments-more")) as {
    data: { issues: { nodes: { attachments: { pageInfo: { endCursor: string | null } } }[] } };
  };
  const node = page.data.issues.nodes[0];
  if (node === undefined) {
    throw new Error("fixture");
  }
  node.attachments.pageInfo.endCursor = null;
  const { fetch: f } = fetcher(() => json(page));
  await expectFailure(f, "truncated");
});

for (const kind of ["not_found", "locked", "unavailable"] as const) {
  test(`keyring ${kind} maps to unauthenticated without a request`, async () => {
    const exec: Exec = () =>
      kind === "not_found"
        ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "", timedOut: false })
        : kind === "locked"
          ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "keyring is locked", timedOut: false })
          : Promise.resolve({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const { fetch: f, calls } = fetcher(() => json({}));
    const message = await expectFailure(f, "unauthenticated", exec);
    expect(message).toContain(kind);
    expect(calls).toHaveLength(0);
  });
}

test("a token that is not a valid header value is unauthenticated", async () => {
  const exec: Exec = () => Promise.resolve({ exitCode: 0, stdout: "bad token\twith space\n", stderr: "", timedOut: false });
  const { fetch: f, calls } = fetcher(() => json({}));
  const message = await expectFailure(f, "unauthenticated", exec);
  expect(message).not.toContain("bad token");
  expect(calls).toHaveLength(0);
});

test("HTTP 401 and 403 map to unauthenticated", async () => {
  for (const status of [401, 403]) {
    const { fetch: f } = fetcher(() => json({}, status));
    await expectFailure(f, "unauthenticated");
  }
});

test("HTTP 429 maps to rate_limited", async () => {
  const { fetch: f } = fetcher(() => json({}, 429));
  await expectFailure(f, "rate_limited");
});

test("RATELIMITED GraphQL error maps to rate_limited", async () => {
  const { fetch: f } = fetcher(() =>
    json({ errors: [{ message: "provider text", extensions: { code: "RATELIMITED" } }] }, 400),
  );
  const message = await expectFailure(f, "rate_limited");
  expect(message).not.toContain("provider text");
});

test("timeout and abort map to timeout", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    const { fetch: f } = fetcher(() => {
      throw Object.assign(new Error("x"), { name });
    });
    await expectFailure(f, "timeout");
  }
});

test("network errors and 5xx map to unavailable", async () => {
  const net = fetcher(() => {
    throw new TypeError(`connect failed ${FAKE}`);
  });
  await expectFailure(net.fetch, "unavailable");
  const server = fetcher(() => json({}, 502));
  await expectFailure(server.fetch, "unavailable");
});

test("GraphQL errors map to invalid_response with type and path only", async () => {
  const { fetch: f } = fetcher(() =>
    json({
      errors: [{ message: "secret provider text", path: ["issues", "nodes"], extensions: { type: "invalid input" } }],
    }),
  );
  const message = await expectFailure(f, "invalid_response");
  expect(message).toContain("invalid input at issues.nodes");
  expect(message).not.toContain("secret provider text");
});

test("shape mismatches map to invalid_response", async () => {
  for (const body of [
    { data: {} },
    { data: { issues: { nodes: [{ identifier: 5 }], pageInfo: { hasNextPage: false } } } },
    { data: { issues: { nodes: [], pageInfo: { hasNextPage: "no" } } } },
  ]) {
    const { fetch: f } = fetcher(() => json(body));
    await expectFailure(f, "invalid_response");
  }
  const notJson = fetcher(() => new Response("<html>", { status: 200 }));
  await expectFailure(notJson.fetch, "invalid_response");
});

test("an unknown state type is invalid_response", async () => {
  const page = (await fixture("page2")) as { data: { issues: { nodes: { state: { type: string } }[] } } };
  const node = page.data.issues.nodes[0];
  if (node === undefined) {
    throw new Error("fixture");
  }
  node.state.type = "weird";
  const { fetch: f } = fetcher(() => json(page));
  await expectFailure(f, "invalid_response");
});

test("started follows the state type and paused the configured state names, matched exactly", async () => {
  const page = (await fixture("page2")) as { data: { issues: { nodes: { state: { name: string; type: string } }[] } } };
  const node = page.data.issues.nodes[0];
  if (node === undefined) throw new Error("fixture has no node");
  const withState = async (
    name: string,
    type: string,
    pausedStates: string[],
  ): Promise<{ state: string; started: boolean; paused: boolean }> => {
    node.state = { name, type };
    const paused = { ...project, issueSource: { kind: "linear", team: "ABC", pausedStates } } as unknown as LinearProject;
    const { fetch: f } = fetcher(() => json(page));
    const result = await source(f).fetchIssues(paused);
    if (!result.ok) throw new Error("expected success");
    const issue = result.data[0];
    if (issue === undefined) throw new Error("expected an issue");
    return { state: issue.state, started: issue.started, paused: issue.paused };
  };
  expect(await withState("On hold", "started", ["On hold"])).toEqual({ state: "On hold", started: true, paused: true });
  expect(await withState("on hold", "started", ["On hold"])).toEqual({ state: "on hold", started: true, paused: false });
  expect(await withState("In Progress", "started", [])).toEqual({ state: "In Progress", started: true, paused: false });
  expect(await withState("Todo", "unstarted", ["On hold"])).toEqual({ state: "Todo", started: false, paused: false });
});

interface LabelPage {
  data: { issues: { nodes: Record<string, unknown>[] } };
}

const withIgnore = { ...project, ignoreLabel: "Pohunek:Ignore" } as unknown as LinearProject;

async function labelledPage(
  names: string[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
): Promise<LabelPage> {
  const page = (await fixture("page2")) as LabelPage;
  const node = page.data.issues.nodes[0];
  if (node === undefined) throw new Error("fixture has no node");
  node["labels"] = { nodes: names.map((name) => ({ name })), pageInfo };
  return page;
}

test("without an ignore label the request has no labels selection and ignored is false", async () => {
  const page = await fixture("page2");
  const run = fetcher(() => json(page));
  const result = await source(run.fetch).fetchIssues(project);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data[0]?.ignored).toBe(false);
  expect(run.calls[0]?.body.query).not.toContain("labels");
  expect(run.calls[0]?.body.variables).not.toHaveProperty("labelsFirst");
});

test("an ignore label adds the labels selection and matches case-insensitively", async () => {
  const page = await labelledPage(["bug", "pohunek:ignore"]);
  const { fetch: f, calls } = fetcher(() => json(page));
  const result = await source(f).fetchIssues(withIgnore);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data[0]?.ignored).toBe(true);
  expect(calls[0]?.body.query).toContain("labels(first: $labelsFirst)");
  expect(calls[0]?.body.variables["labelsFirst"]).toBe(1);
});

test("an issue without the ignore label is not ignored", async () => {
  const page = await labelledPage(["bug", "pohunek:ignored"]);
  const { fetch: f, calls } = fetcher(() => json(page));
  const result = await source(f).fetchIssues(withIgnore);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data[0]?.ignored).toBe(false);
  expect(calls).toHaveLength(1);
});

test("labels are paged until the ignore label is found", async () => {
  const first = await labelledPage(["bug"], { hasNextPage: true, endCursor: "lab-1" });
  const second = {
    data: { issue: { labels: { nodes: [{ name: "POHUNEK:IGNORE" }], pageInfo: { hasNextPage: false, endCursor: null } } } },
  };
  const bodies = [first, second];
  const { fetch: f, calls } = fetcher((_c, i) => json(bodies[i]));
  const result = await source(f).fetchIssues(withIgnore);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data[0]?.ignored).toBe(true);
  expect(calls[1]?.body.variables).toEqual({ id: "00000000-0000-0000-0000-000000000002", first: 1, after: "lab-1" });
});

test("a complete multi-page label list without the label is not ignored", async () => {
  const first = await labelledPage(["bug"], { hasNextPage: true, endCursor: "lab-1" });
  const second = { data: { issue: { labels: { nodes: [{ name: "ui" }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
  const bodies = [first, second];
  const { fetch: f } = fetcher((_c, i) => json(bodies[i]));
  const result = await source(f).fetchIssues(withIgnore);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data[0]?.ignored).toBe(false);
});

test("label pagination without a cursor is truncated", async () => {
  const page = await labelledPage(["bug"], { hasNextPage: true, endCursor: null });
  const { fetch: f } = fetcher(() => json(page));
  const result = await source(f).fetchIssues(withIgnore);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("truncated");
});

test("a repeated label cursor is truncated", async () => {
  const first = await labelledPage(["bug"], { hasNextPage: true, endCursor: "lab-1" });
  const again = { data: { issue: { labels: { nodes: [{ name: "ui" }], pageInfo: { hasNextPage: true, endCursor: "lab-1" } } } } };
  const bodies = [first, again];
  const { fetch: f } = fetcher((_c, i) => json(bodies[i]));
  const result = await source(f).fetchIssues(withIgnore);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("truncated");
});

test("a missing labels connection under an ignore label is invalid_response", async () => {
  const page = await fixture("page2");
  const { fetch: f } = fetcher(() => json(page));
  const result = await source(f).fetchIssues(withIgnore);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("invalid_response");
});

// Targeted ignore-label lookup of issues the list did not return.
const lookupPage = (nodes: { identifier: string; id?: string; labels: string[]; more?: string }[], hasNextPage = false): unknown => ({
  data: {
    issues: {
      nodes: nodes.map((node, index) => ({
        id: node.id ?? `id-${index.toString()}`,
        identifier: node.identifier,
        labels: {
          nodes: node.labels.map((name) => ({ name })),
          pageInfo: { hasNextPage: node.more !== undefined, endCursor: node.more ?? null },
        },
      })),
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "more" : null },
    },
  },
});

async function ignoredKeys(f: typeof fetch, keys: readonly string[], p: LinearProject = withIgnore): ReturnType<ReturnType<typeof createLinearSource>["fetchIgnoredKeys"]> {
  return source(f).fetchIgnoredKeys(p, keys);
}

test("the lookup asks the team's issues by number, with the first label page, and reports the labelled keys", async () => {
  const run = fetcher(() => json(lookupPage([{ identifier: "ABC-1", labels: ["bug", "pohunek:IGNORE"] }])));
  const result = await ignoredKeys(run.fetch, ["ABC-1"]);
  expect(result).toMatchObject({ ok: true, source: "linear" });
  if (!result.ok) return;
  expect([...result.data]).toEqual(["ABC-1"]);
  expect(run.calls).toHaveLength(1);
  expect(run.calls[0]?.body.query).toContain("number: { in: $numbers }");
  expect(run.calls[0]?.body.query).toContain("team: { key: { eq: $teamKey } }");
  expect(run.calls[0]?.body.variables).toEqual({ first: 1, teamKey: "ABC", numbers: [1], labelsFirst: 1 });
});

test("an issue without the ignore label and a key Linear does not return are not reported", async () => {
  const run = fetcher(() => json(lookupPage([{ identifier: "ABC-1", labels: ["bug"] }])));
  const result = await ignoredKeys(run.fetch, ["ABC-1"]);
  expect(result.ok && result.data.size).toBe(0);
  const empty = fetcher(() => json(lookupPage([])));
  const none = await ignoredKeys(empty.fetch, ["ABC-9"]);
  expect(none.ok && none.data.size).toBe(0);
});

test("keys are batched by page_size and the requested spelling is reported", async () => {
  const bodies = [lookupPage([{ identifier: "ABC-1", labels: ["pohunek:ignore"] }]), lookupPage([{ identifier: "ABC-2", labels: [] }])];
  const run = fetcher((_c, i) => json(bodies[i]));
  const result = await ignoredKeys(run.fetch, ["abc-1", "ABC-2"]);
  expect(run.calls.map((c) => c.body.variables["numbers"])).toEqual([[1], [2]]);
  expect(result.ok && [...result.data]).toEqual(["abc-1"]);
});

test("keys of another team or of another shape are never asked for", async () => {
  const run = fetcher(() => json(lookupPage([])));
  const result = await ignoredKeys(run.fetch, ["XYZ-1", "not-a-key", "ABC-0", "ABC-x"]);
  expect(run.calls).toHaveLength(0);
  expect(result.ok && result.data.size).toBe(0);
});

test("a project without an ignore label asks nothing", async () => {
  const run = fetcher(() => json(lookupPage([])));
  const result = await ignoredKeys(run.fetch, ["ABC-1"], project);
  expect(run.calls).toHaveLength(0);
  expect(result.ok && result.data.size).toBe(0);
});

test("the lookup follows a label page cut short and fails truncated when it cannot", async () => {
  const first = lookupPage([{ identifier: "ABC-1", labels: ["bug"], more: "lab-1", id: "uuid-1" }]);
  const second = { data: { issue: { labels: { nodes: [{ name: "Pohunek:Ignore" }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
  const paged = fetcher((_c, i) => json([first, second][i]));
  const found = await ignoredKeys(paged.fetch, ["ABC-1"]);
  expect(found.ok && [...found.data]).toEqual(["ABC-1"]);
  expect(paged.calls[1]?.body.variables).toEqual({ id: "uuid-1", first: 1, after: "lab-1" });
  const looping = { data: { issue: { labels: { nodes: [{ name: "x" }], pageInfo: { hasNextPage: true, endCursor: "lab-1" } } } } };
  const stuck = fetcher((_c, i) => json([first, looping][i]));
  expect(await ignoredKeys(stuck.fetch, ["ABC-1"])).toMatchObject({ ok: false, code: "truncated" });
});

test("more issues than asked for, an error and a bad shape fail the lookup", async () => {
  const more = fetcher(() => json(lookupPage([{ identifier: "ABC-1", labels: [] }], true)));
  expect(await ignoredKeys(more.fetch, ["ABC-1"])).toMatchObject({ ok: false, code: "truncated" });
  const limited = fetcher(() => json({ errors: [{ extensions: { code: "RATELIMITED" } }] }));
  expect(await ignoredKeys(limited.fetch, ["ABC-1"])).toMatchObject({ ok: false, code: "rate_limited" });
  const broken = fetcher(() => json({ data: { issues: { nodes: [{ id: "i", identifier: "ABC-1" }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
  expect(await ignoredKeys(broken.fetch, ["ABC-1"])).toMatchObject({ ok: false, code: "invalid_response" });
  const down = fetcher(() => json({}, 503));
  expect(await ignoredKeys(down.fetch, ["ABC-1"])).toMatchObject({ ok: false, code: "unavailable" });
});
