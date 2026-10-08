import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDoEnvelope, decodeListEnvelope } from "../../src/tui/decode.ts";
import { envelopeText, payload, row, RULE_ROWS } from "./builders.ts";

const CONTRACT = readFileSync(join(import.meta.dir, "..", "fixtures", "output", "list-contract.json"), "utf8");

describe("decodeListEnvelope", () => {
  test("decodes the list --json contract fixture exactly", () => {
    const outcome = decodeListEnvelope(CONTRACT);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const raw = JSON.parse(CONTRACT) as { ok: unknown };
    expect(outcome.payload).toEqual(raw.ok as typeof outcome.payload);
  });

  test("a session needs a string indicator and a nullable updated_at", () => {
    const good = JSON.parse(envelopeText(payload([row("linear:A-1", { sessions: [{ id: "s-1", name: null, role: null, state: "stopped", activity: null, indicator: "stopped", updated_at: null }] })]))) as { ok: { items: { sessions: Record<string, unknown>[] }[] } };
    expect(decodeListEnvelope(JSON.stringify(good)).kind).toBe("ok");
    const first = good.ok.items[0]?.sessions[0];
    if (first === undefined) throw new Error("fixture");
    first["updated_at"] = "2026-06-15T10:00:00Z";
    expect(decodeListEnvelope(JSON.stringify(good)).kind).toBe("ok");
    first["updated_at"] = 5;
    expect(decodeListEnvelope(JSON.stringify(good))).toEqual({ kind: "malformed", message: "ok.items[0].sessions[0].updated_at is not a string" });
    first["updated_at"] = null;
    delete first["indicator"];
    expect(decodeListEnvelope(JSON.stringify(good))).toEqual({ kind: "malformed", message: "ok.items[0].sessions[0].indicator is not a string" });
  });

  test("round-trips every rule row", () => {
    const outcome = decodeListEnvelope(envelopeText(payload(RULE_ROWS)));
    expect(outcome.kind === "ok" ? outcome.payload.items : null).toEqual(RULE_ROWS);
  });

  test.each([
    ["", "no output"],
    ["{", "output is not JSON"],
    ["[]", "envelope is not an object"],
    ['{"protocol":{"minimum":1,"maximum":1},"ok":{}}', "cli_version is not a string"],
    ['{"cli_version":"1","ok":{}}', "protocol is not an object"],
    ['{"cli_version":"1","protocol":{"minimum":4,"maximum":4}}', "envelope has neither ok nor err"],
    ['{"cli_version":"1","protocol":{"minimum":4,"maximum":4},"ok":{"items":{}}}', "ok.items is not an array"],
  ])("malformed %p: %s", (text, message) => {
    expect(decodeListEnvelope(text)).toEqual({ kind: "malformed", message });
  });

  test("a row with a wrong type is malformed, naming the path", () => {
    const bad = JSON.parse(envelopeText(payload([row("linear:A-1")]))) as { ok: { items: Record<string, unknown>[] } };
    const first = bad.ok.items[0];
    if (first === undefined) throw new Error("fixture");
    first["on_turn"] = { actor: "somebody", reason: "x", rule: 1 };
    expect(decodeListEnvelope(JSON.stringify(bad))).toEqual({ kind: "malformed", message: "ok.items[0].on_turn.actor has an unknown value" });
    first["on_turn"] = { actor: "me", reason: "close or follow up", rule: 13 };
    expect(decodeListEnvelope(JSON.stringify(bad)).kind).toBe("ok");
    first["on_turn"] = { actor: "me", reason: "x", rule: 14 };
    expect(decodeListEnvelope(JSON.stringify(bad))).toEqual({ kind: "malformed", message: "ok.items[0].on_turn.rule is not a known rule" });
  });

  test("the github_issues status of a row is required and a github-issue row decodes", () => {
    const good = JSON.parse(envelopeText(payload([row("github-issue:acme/widgets#7")]))) as { ok: { items: { sources: Record<string, unknown> }[] } };
    expect(decodeListEnvelope(JSON.stringify(good)).kind).toBe("ok");
    const sources = good.ok.items[0]?.sources;
    if (sources === undefined) throw new Error("fixture");
    delete sources["github_issues"];
    expect(decodeListEnvelope(JSON.stringify(good))).toEqual({ kind: "malformed", message: "ok.items[0].sources.github_issues is not a string" });
  });

  test("omitted_ignored is a required non-negative integer and round-trips", () => {
    const good = JSON.parse(envelopeText(payload([row("linear:A-1")], undefined, 3))) as { ok: Record<string, unknown> };
    const outcome = decodeListEnvelope(JSON.stringify(good));
    expect(outcome.kind === "ok" ? outcome.payload.omitted_ignored : null).toBe(3);
    const rejected = (value: unknown, message: string): void => {
      good.ok["omitted_ignored"] = value;
      expect(decodeListEnvelope(JSON.stringify(good))).toEqual({ kind: "malformed", message });
    };
    rejected(-1, "ok.omitted_ignored is negative");
    rejected(1.5, "ok.omitted_ignored is not an integer");
    rejected("2", "ok.omitted_ignored is not an integer");
    delete good.ok["omitted_ignored"];
    expect(decodeListEnvelope(JSON.stringify(good))).toEqual({ kind: "malformed", message: "ok.omitted_ignored is not an integer" });
  });

  test("the ignored flag of a row is required, boolean and round-trips", () => {
    const good = JSON.parse(envelopeText(payload([row("linear:A-1", { ignored: true })]))) as { ok: { items: Record<string, unknown>[] } };
    const first = good.ok.items[0];
    if (first === undefined) throw new Error("fixture");
    const outcome = decodeListEnvelope(JSON.stringify(good));
    expect(outcome.kind === "ok" ? outcome.payload.items[0]?.ignored : null).toBe(true);
    first["ignored"] = "yes";
    expect(decodeListEnvelope(JSON.stringify(good))).toEqual({ kind: "malformed", message: "ok.items[0].ignored is not a boolean" });
    delete first["ignored"];
    expect(decodeListEnvelope(JSON.stringify(good))).toEqual({ kind: "malformed", message: "ok.items[0].ignored is not a boolean" });
  });

  test("the err envelope is decoded with its class, code and message", () => {
    const text = JSON.stringify({
      cli_version: "0.1.0",
      protocol: { minimum: 4, maximum: 4 },
      err: { class: "configuration", code: "config_invalid", msg: "config.toml: tui is required" },
    });
    expect(decodeListEnvelope(text)).toEqual({
      kind: "error",
      cliVersion: "0.1.0",
      err: { class: "configuration", code: "config_invalid", msg: "config.toml: tui is required" },
    });
  });

  test.each([
    [{ minimum: 5, maximum: 6 }],
    [{ minimum: 3, maximum: 3 }],
    [{ minimum: 0, maximum: 0 }],
  ])("protocol %p excludes v4: incompatible, payload not read", (protocol) => {
    const outcome = decodeListEnvelope(JSON.stringify({ cli_version: "9.0.0", protocol, ok: "anything" }));
    expect(outcome.kind).toBe("incompatible");
  });

  test("a different cli_version within the protocol range decodes (shown as a header warning)", () => {
    const outcome = decodeListEnvelope(envelopeText(payload([]), "7.7.7"));
    expect(outcome.kind === "ok" ? outcome.cliVersion : null).toBe("7.7.7");
  });

  test("unknown action names are kept for display; the allowlist decides what runs", () => {
    const outcome = decodeListEnvelope(envelopeText(payload([row("linear:A-1", { actions: [{ name: "merge", delegable: false }, { name: "teleport", delegable: true, profile: "x" }] })])));
    expect(outcome.kind === "ok" ? outcome.payload.items[0]?.actions : null).toEqual([
      { name: "merge", delegable: false },
      { name: "teleport", delegable: true, profile: "x" },
    ]);
  });
});

function doEnvelope(ok: unknown, protocol = { minimum: 1, maximum: 1 }): string {
  return JSON.stringify({ cli_version: "0.1.0", protocol, ok });
}

describe("decodeDoEnvelope", () => {
  test("a launch dry run: action at ok.plan.action, fields in display order, no result", () => {
    const outcome = decodeDoEnvelope(
      doEnvelope({
        dry_run: true,
        plan: {
          action: "implement",
          key: "linear:DMD-1",
          project: "connection",
          profile: "claude-otel",
          branch: "zajca/DMD-1/x",
          cwd: null,
          name: "DMD-1",
          metadata: { "work.role": "implement" },
          argv: ["/bin/pohunek", "session", "new", "--json"],
          prompt: "line one\nline two",
        },
      }),
    );
    expect(outcome).toEqual({
      kind: "ok",
      dryRun: true,
      action: "implement",
      key: "linear:DMD-1",
      plan: [
        { label: "profile", value: "claude-otel" },
        { label: "branch", value: "zajca/DMD-1/x" },
        { label: "name", value: "DMD-1" },
        { label: "argv", value: "/bin/pohunek session new --json" },
        { label: "prompt", value: "line one\nline two" },
      ],
      result: null,
    });
  });

  test("a ready run carries its result", () => {
    const outcome = decodeDoEnvelope(
      doEnvelope({
        dry_run: false,
        plan: { action: "ready", key: "github:a/b#1", project: "p", pull_request: "a/b#1", argv: ["gh"], verify_argv: ["gh", "view"] },
        result: { pull_request: "a/b#1", is_draft: false },
      }),
    );
    expect(outcome.kind === "ok" ? outcome.result : null).toEqual([
      { label: "pull_request", value: "a/b#1" },
      { label: "is_draft", value: "no" },
    ]);
  });

  test("an attach dry run decodes", () => {
    const outcome = decodeDoEnvelope(
      doEnvelope({ dry_run: true, plan: { action: "attach", key: "linear:A-1", project: "p", session_id: "s-1", argv: ["/bin/pohunek", "attach", "s-1"] } }),
    );
    expect(outcome.kind === "ok" ? outcome.plan : null).toEqual([
      { label: "session_id", value: "s-1" },
      { label: "argv", value: "/bin/pohunek attach s-1" },
    ]);
  });

  test("refusal, incompatible and malformed", () => {
    const refusal = JSON.stringify({
      cli_version: "0.1.0",
      protocol: { minimum: 1, maximum: 1 },
      err: { class: "action", code: "confirmation_required", msg: "not confirmed; nothing was executed" },
    });
    expect(decodeDoEnvelope(refusal)).toEqual({
      kind: "error",
      err: { class: "action", code: "confirmation_required", msg: "not confirmed; nothing was executed" },
    });
    expect(decodeDoEnvelope(doEnvelope({}, { minimum: 2, maximum: 2 })).kind).toBe("incompatible");
    expect(decodeDoEnvelope(doEnvelope({ dry_run: false, plan: { action: "ready", key: "k" } }))).toEqual({
      kind: "malformed",
      message: "ok.result is not an object",
    });
    expect(decodeDoEnvelope("started session s-1")).toEqual({ kind: "malformed", message: "output is not JSON" });
  });
});
