import { describe, expect, test } from "bun:test";
import { attachArgv, checkOpenUrl, isTuiAction, listArgv, previewArgv, TUI_ACTIONS, writeArgv } from "../../src/tui/actions.ts";

const BIN = "/opt/bin/pohunek-work";

describe("allowlist", () => {
  test("exactly the seven actions; merge is not one of them", () => {
    expect([...TUI_ACTIONS]).toEqual(["implement", "babysit", "fix-ci", "rebase", "review", "ready", "attach"]);
    expect(isTuiAction("merge")).toBe(false);
    expect(isTuiAction("MERGE")).toBe(false);
    expect(isTuiAction("")).toBe(false);
  });
});

describe("argv builders", () => {
  test("list", () => {
    expect(listArgv(BIN)).toEqual([BIN, "list", "--json"]);
  });

  test("preview, write and attach carry --project and the exact flags of section 4.1", () => {
    expect(previewArgv(BIN, "linear:DMD-1", "implement", "connection")).toEqual({
      ok: true,
      argv: [BIN, "do", "linear:DMD-1", "implement", "--project", "connection", "--dry-run", "--json"],
    });
    expect(writeArgv(BIN, "github:keboola/connection#12", "ready", "connection")).toEqual({
      ok: true,
      argv: [BIN, "do", "github:keboola/connection#12", "ready", "--project", "connection", "--json"],
    });
    expect(attachArgv(BIN, "linear:DMD-1", "connection")).toEqual({
      ok: true,
      argv: [BIN, "do", "linear:DMD-1", "attach", "--project", "connection"],
    });
    expect(previewArgv(BIN, "linear:DMD-1", "attach", "connection")).toEqual({
      ok: true,
      argv: [BIN, "do", "linear:DMD-1", "attach", "--project", "connection", "--dry-run", "--json"],
    });
  });

  test.each([
    "--yes",
    "-x",
    "linear:dmd-1",
    "linear:DMD-1 --yes",
    "linear:DMD-",
    "github:owner/name",
    "github:owner/name#1;rm",
    "github:-owner/name#1 x",
    "jira:ABC-1",
    "",
  ])("key %p is refused", (key) => {
    expect(previewArgv(BIN, key, "implement", "connection").ok).toBe(false);
    expect(writeArgv(BIN, key, "implement", "connection").ok).toBe(false);
    expect(attachArgv(BIN, key, "connection").ok).toBe(false);
  });

  test.each(["--project", "-p", "", "con nection", "con/nection", ".hidden"])("project %p is refused", (project) => {
    expect(writeArgv(BIN, "linear:DMD-1", "babysit", project).ok).toBe(false);
    expect(attachArgv(BIN, "linear:DMD-1", project).ok).toBe(false);
  });

  test("merge and unknown actions never produce an argv", () => {
    for (const action of ["merge", "teleport", "--yes"]) {
      expect(previewArgv(BIN, "linear:DMD-1", action, "connection")).toEqual({ ok: false, reason: `action ${action} is not supported by the TUI` });
      expect(writeArgv(BIN, "linear:DMD-1", action, "connection").ok).toBe(false);
    }
  });

  test("attach is not a write", () => {
    expect(writeArgv(BIN, "linear:DMD-1", "attach", "connection")).toEqual({ ok: false, reason: "attach is not a write" });
  });

  test("property: over every action name and valid target, no argv element is merge", () => {
    const names = [...TUI_ACTIONS, "merge", "Merge", "merge ", "pr-merge"];
    for (const name of names) {
      for (const build of [previewArgv, writeArgv]) {
        const result = build(BIN, "linear:DMD-1", name, "connection");
        if (result.ok) expect(result.argv.some((element) => element.toLowerCase().includes("merge"))).toBe(false);
      }
    }
  });
});

describe("checkOpenUrl", () => {
  const hosts = ["github.com", "linear.app"];

  test("an https URL on an allowed host passes as its parsed href", () => {
    expect(checkOpenUrl("https://github.com/keboola/connection/pull/1", hosts)).toEqual({
      ok: true,
      href: "https://github.com/keboola/connection/pull/1",
      host: "github.com",
    });
  });

  test.each([
    ["http://github.com/x", "only https URLs are opened"],
    ["javascript:alert(1)", "only https URLs are opened"],
    ["file:///etc/passwd", "only https URLs are opened"],
    ["https://evil.example/github.com", "host evil.example is not in open_url_hosts"],
    ["https://github.com.evil.example/", "host github.com.evil.example is not in open_url_hosts"],
    ["https://api.github.com/", "host api.github.com is not in open_url_hosts"],
    ["https://user:pw@github.com/", "URLs with credentials are not opened"],
    ["https://github.com:8443/", "URLs with an explicit port are not opened"],
    ["not a url", "the URL does not parse"],
    ["-https://github.com", "the URL does not parse"],
  ])("%p is refused: %s", (url, reason) => {
    expect(checkOpenUrl(url, hosts)).toEqual({ ok: false, reason });
  });

  test("the host comparison happens on the parsed, lowercased host", () => {
    expect(checkOpenUrl("https://GitHub.COM/x", hosts)).toEqual({ ok: true, href: "https://github.com/x", host: "github.com" });
  });
});
