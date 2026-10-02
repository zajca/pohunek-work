import { expect, test } from "bun:test";
import { runList } from "../../src/tui/children.ts";
import { SpawnError, type Exec, type ExecOptions, type ExecResult } from "../../src/util/exec.ts";
import { envelopeText, payload, RULE_ROWS } from "./builders.ts";

function fakeExec(result: ExecResult | Error): { exec: Exec; calls: { argv: readonly string[]; options: ExecOptions }[] } {
  const calls: { argv: readonly string[]; options: ExecOptions }[] = [];
  return {
    calls,
    exec: (argv, options) => {
      calls.push({ argv, options });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

let clock = 0;
const now = (): number => (clock += 10);

test("runs the exact argv with list_timeout_ms and decodes stdout", async () => {
  const { exec, calls } = fakeExec({ exitCode: 0, stdout: envelopeText(payload(RULE_ROWS)), stderr: "", timedOut: false });
  const result = await runList(exec, ["/opt/bin/pohunek-work", "list", "--json"], 60_000, now);
  expect(calls).toEqual([{ argv: ["/opt/bin/pohunek-work", "list", "--json"], options: { timeoutMs: 60_000 } }]);
  expect(result.outcome?.kind).toBe("ok");
  expect(result.run).toEqual({ exitCode: 0, timedOut: false, spawnError: null, stderr: [] });
  expect(result.durationMs).toBe(10);
});

test("exit 3 still decodes stdout and keeps stderr lines", async () => {
  const { exec } = fakeExec({
    exitCode: 3,
    stdout: envelopeText(payload(RULE_ROWS)),
    stderr: "source unavailable: ops github: rate_limited\n\nproject x: left out\n",
    timedOut: false,
  });
  const result = await runList(exec, ["/bin/x", "list", "--json"], 1000, now);
  expect(result.outcome?.kind).toBe("ok");
  expect(result.run.exitCode).toBe(3);
  expect(result.run.stderr).toEqual(["source unavailable: ops github: rate_limited", "project x: left out"]);
});

test("a timeout yields no outcome", async () => {
  const { exec } = fakeExec({ exitCode: null, stdout: "", stderr: "", timedOut: true });
  const result = await runList(exec, ["/bin/x", "list", "--json"], 1000, now);
  expect(result.outcome).toBeNull();
  expect(result.run.timedOut).toBe(true);
});

test("an err envelope on exit 2 is decoded", async () => {
  const stdout = JSON.stringify({ cli_version: "0.1.0", protocol: { minimum: 1, maximum: 1 }, err: { class: "configuration", code: "config_invalid", msg: "m" } });
  const { exec } = fakeExec({ exitCode: 2, stdout, stderr: "", timedOut: false });
  expect((await runList(exec, ["/bin/x", "list", "--json"], 1000, now)).outcome?.kind).toBe("error");
});

test("a binary that cannot start is a spawn error, not an exception", async () => {
  const { exec } = fakeExec(new SpawnError("/missing/pohunek-work", new Error("ENOENT")));
  const result = await runList(exec, ["/missing/pohunek-work", "list", "--json"], 1000, now);
  expect(result.run.spawnError).toBe("cannot start /missing/pohunek-work");
  expect(result.outcome).toBeNull();
});

test("other exec failures propagate", async () => {
  const { exec } = fakeExec(new TypeError("boom"));
  expect(await runList(exec, ["/bin/x"], 1000, now).then(() => null, (error: unknown) => error)).toBeInstanceOf(TypeError);
});

test("a real child: argv elements are never interpreted by a shell", async () => {
  const { exec } = await import("../../src/util/exec.ts");
  const result = await runList(exec, ["/bin/echo", "$(id)", ";", "list"], 5000, now);
  expect(result.outcome).toEqual({ kind: "malformed", message: "output is not JSON" });
});
