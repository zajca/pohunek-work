import { expect, test } from "bun:test";
import {
  buildConnectionRequest,
  buildIssueSearchRequest,
  buildProjectStatusValidationRequest,
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
  "issueProjectItems",
  "pullRequestLabels",
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
    buildSearchRequest([{ alias: "authored", queryString: "q", after: null }], sizes, { closingReferences: false, pullRequestLabels: false }),
  );
});

test("the search request declares exactly the variables it uses with and without the closing references", () => {
  const search = [{ alias: "authored", queryString: "q", after: null }];
  const withReferences = buildSearchRequest(search, sizes, { closingReferences: true, pullRequestLabels: false });
  expectVariablesConsistent(withReferences);
  expect(withReferences.query).toContain("closingIssuesReferences(first: $nested)");
  expect(buildSearchRequest(search, sizes, { closingReferences: false, pullRequestLabels: false }).query).not.toContain("closingIssuesReferences");
});

test("the pull request labels are selected only when the shape asks for them", () => {
  const search = [{ alias: "authored", queryString: "q", after: null }];
  const withLabels = buildSearchRequest(search, sizes, { closingReferences: false, pullRequestLabels: true });
  expectVariablesConsistent(withLabels);
  expect(withLabels.query).toContain("labels(first: $nested)");
  const without = buildSearchRequest(search, sizes, { closingReferences: false, pullRequestLabels: false });
  expect(without.query).not.toContain("labels");
  expect(without.query).toContain("commits(last: 1)");
});

test("the issue search request declares exactly the variables it uses and carries the search string as a variable", () => {
  const request = buildIssueSearchRequest("repo:acme/widgets is:issue", null, { issuePageSize: 5, nestedPageSize: 4 }, null);
  expectVariablesConsistent(request);
  expect(request.variables).toEqual({ q: "repo:acme/widgets is:issue", top: 5, nested: 4, after: null });
  expect(request.query).not.toContain("acme/widgets");
  expect(request.query).not.toContain("projectItems");
  expect(request.query).not.toContain("statusField");
});

test("the issue search selects the Project items only for a status field and passes its name as a variable", () => {
  const request = buildIssueSearchRequest("q", null, { issuePageSize: 5, nestedPageSize: 4 }, "Sprint \"status\" { x }");
  expectVariablesConsistent(request);
  expect(request.variables).toEqual({ q: "q", top: 5, nested: 4, after: null, statusField: "Sprint \"status\" { x }" });
  expect(request.query).toContain("projectItems(first: $nested)");
  expect(request.query).toContain("fieldValueByName(name: $statusField)");
  expect(request.query).not.toContain("Sprint");
});

test("the Project validation request carries owner, number and field as variables only", () => {
  const request = buildProjectStatusValidationRequest("acme-org", 3, "Sprint-field");
  expectVariablesConsistent(request);
  expect(request.variables).toEqual({ o: "acme-org", n: 3, f: "Sprint-field" });
  expect(request.query).not.toContain("acme-org");
  expect(request.query).not.toContain("Sprint-field");
  expect(request.query).not.toContain("mutation");
});

test("a Project items follow-up page declares the status field variable and omits it for other kinds", () => {
  const page = { alias: "c0", kind: "issueProjectItems", nodeId: "N", after: "A" } as const;
  const request = buildConnectionRequest([page], sizes, "Status");
  expectVariablesConsistent(request);
  expect(request.variables["statusField"]).toBe("Status");
  expect(request.query).toContain("... on Issue { projectItems(first: $nested, after: $after_c0)");
  expect(() => buildConnectionRequest([page], sizes)).toThrow();
  const labels = buildConnectionRequest([{ alias: "c0", kind: "issueLabels", nodeId: "N", after: "A" }], sizes, "Status");
  expect(labels.variables).not.toHaveProperty("statusField");
});

test("every single-kind connection request declares exactly the variables it uses", () => {
  for (const kind of KINDS) {
    expectVariablesConsistent(
      buildConnectionRequest([{ alias: "c0", kind, nodeId: "N", after: "A" }], sizes, "Status"),
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
          "Status",
        ),
      );
    }
  }
});
