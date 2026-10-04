import { expect, test } from "bun:test";
import {
  buildConnectionRequest,
  buildIssueSearchRequest,
  buildSearchRequest,
  type ConnectionKind,
  type GraphqlRequest,
} from "../../src/sources/github-query.ts";

const sizes = { pullRequestPageSize: 5, nestedPageSize: 4, threadCommentPageSize: 3 };
const KINDS: readonly ConnectionKind[] = [
  "reviews",
  "reviewThreads",
  "timelineItems",
  "reviewRequests",
  "checkContexts",
  "threadComments",
  "closingIssues",
  "issueLabels",
];

/** GraphQL rejects declared-but-unused variables and used-but-undeclared ones. */
function expectVariablesConsistent(request: GraphqlRequest): void {
  const header = /query \w+\(([^)]*)\)/.exec(request.query)?.[1] ?? "";
  const declared = [...header.matchAll(/\$(\w+):/g)].map((match) => match[1] ?? "");
  const body = request.query.slice(request.query.indexOf("{"));
  const used = new Set([...body.matchAll(/\$(\w+)/g)].map((match) => match[1] ?? ""));
  expect([...declared].sort()).toEqual([...used].sort());
  expect(Object.keys(request.variables).sort()).toEqual([...declared].sort());
}

test("the search request declares exactly the variables it uses", () => {
  expectVariablesConsistent(
    buildSearchRequest([{ alias: "authored", queryString: "q", after: null }], sizes, { closingReferences: false }),
  );
});

test("the search request declares exactly the variables it uses with and without the closing references", () => {
  const search = [{ alias: "authored", queryString: "q", after: null }];
  const withReferences = buildSearchRequest(search, sizes, { closingReferences: true });
  expectVariablesConsistent(withReferences);
  expect(withReferences.query).toContain("closingIssuesReferences(first: $nested)");
  expect(buildSearchRequest(search, sizes, { closingReferences: false }).query).not.toContain("closingIssuesReferences");
});

test("the issue search request declares exactly the variables it uses and carries the search string as a variable", () => {
  const request = buildIssueSearchRequest("repo:acme/widgets is:issue", null, { issuePageSize: 5, nestedPageSize: 4 });
  expectVariablesConsistent(request);
  expect(request.variables).toEqual({ q: "repo:acme/widgets is:issue", top: 5, nested: 4, after: null });
  expect(request.query).not.toContain("acme/widgets");
});

test("every single-kind connection request declares exactly the variables it uses", () => {
  for (const kind of KINDS) {
    expectVariablesConsistent(
      buildConnectionRequest([{ alias: "c0", kind, nodeId: "N", after: "A" }], sizes),
    );
  }
});

test("mixed connection requests declare exactly the variables they use", () => {
  for (const first of KINDS) {
    for (const second of KINDS) {
      expectVariablesConsistent(
        buildConnectionRequest(
          [
            { alias: "c0", kind: first, nodeId: "N0", after: "A0" },
            { alias: "c1", kind: second, nodeId: "N1", after: "A1" },
          ],
          sizes,
        ),
      );
    }
  }
});
