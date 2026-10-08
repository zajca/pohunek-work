import { describe, expect, test } from "bun:test";
import { canonicalPullRequestUrl, samePullRequestUrl } from "../../src/util/pr-url.ts";

const PLAIN = "https://github.com/acme/widgets/pull/12";

describe("canonicalPullRequestUrl", () => {
  test.each([
    PLAIN,
    `${PLAIN}/`,
    `${PLAIN}/files`,
    `${PLAIN}/files/`,
    `${PLAIN}/files/abc123`,
    `${PLAIN}/commits`,
    `${PLAIN}/commits/abc123`,
    `${PLAIN}/checks`,
    `${PLAIN}/checks?check_run_id=7`,
    `${PLAIN}?diff=split`,
    `${PLAIN}#discussion_r1`,
    `${PLAIN}/files?w=1#diff-abc`,
    "https://GitHub.COM/Acme/Widgets/PULL/12",
  ])("canonicalizes %s", (url) => {
    expect(canonicalPullRequestUrl(url)).toBe(PLAIN);
  });

  test.each([
    "http://github.com/acme/widgets/pull/12",
    "https://www.github.com/acme/widgets/pull/12",
    "https://github.example/acme/widgets/pull/12",
    "https://github.com:8443/acme/widgets/pull/12",
    "https://github.com/acme/widgets/pull/12/filesx",
    "https://github.com/acme/widgets/pull/12/other",
    "https://github.com/acme/widgets/pull/0",
    "https://github.com/acme/widgets/pull/x",
    "https://github.com/acme/widgets/issues/12",
    "https://github.com/acme/widgets",
    "https://linear.app/acme/issue/ABC-1",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(canonicalPullRequestUrl(url)).toBeNull();
  });
});

describe("samePullRequestUrl", () => {
  test.each([`${PLAIN}/`, `${PLAIN}/files/x`, `${PLAIN}?a=b#c`, "https://github.com/ACME/Widgets/pull/12"])(
    "%s names the same pull request",
    (other) => {
      expect(samePullRequestUrl(other, PLAIN)).toBe(true);
      expect(samePullRequestUrl(PLAIN, other)).toBe(true);
    },
  );

  test.each([
    "http://github.com/acme/widgets/pull/12",
    "https://www.github.com/acme/widgets/pull/12",
    "https://github.com/acme/widgets/pull/123",
    "https://github.com/acme/other/pull/12",
  ])("%s is another pull request", (other) => {
    expect(samePullRequestUrl(other, PLAIN)).toBe(false);
  });

  test("a URL without a canonical form is compared as a string", () => {
    expect(samePullRequestUrl("https://x.example/a", "https://x.example/a")).toBe(true);
    expect(samePullRequestUrl("https://x.example/a", "https://x.example/A")).toBe(false);
    expect(samePullRequestUrl("https://x.example/a", PLAIN)).toBe(false);
  });
});
