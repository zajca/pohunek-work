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
const project = { name: "widgets", issueSource: { kind: "linear", team: "ABC", pausedStates: [] } } as unknown as LinearProject;

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

test("normalizes issues across two pages, with cycle null and attachments", async () => {
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
      stateName: "In Progress",
      stateType: "started",
      teamKey: "ABC",
      assigneeIsMe: true,
      cycle: {
        number: 7,
        name: "Cycle seven",
        startsAt: "2026-09-28T00:00:00.000Z",
        endsAt: "2026-10-12T00:00:00.000Z",
      },
      attachments: [{ url: "https://github.com/acme/widgets/pull/12" }],
    },
    {
      id: "ABC-2",
      title: "Fix widget layout",
      url: "https://linear.example/acme/issue/ABC-2",
      stateName: "In Review",
      stateType: "started",
      teamKey: "ABC",
      assigneeIsMe: true,
      cycle: null,
      attachments: [],
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
  expect(result.data[0]?.attachments).toEqual([
    { url: "https://github.com/acme/widgets/pull/30" },
    { url: "https://github.com/acme/widgets/pull/31" },
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
