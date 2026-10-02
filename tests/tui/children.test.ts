import { describe, expect, test } from "bun:test";
import {
  openUrl,
  RETURN_PROMPT,
  runHandover,
  runList,
  runPreview,
  spawnDetached,
  spawnForeground,
  type ForegroundSpawn,
} from "../../src/tui/children.ts";
import type { Terminal } from "../../src/tui/terminal.ts";
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

test("runPreview runs the exact argv with the list timeout and decodes the do envelope", async () => {
  const stdout = JSON.stringify({
    cli_version: "0.1.0",
    protocol: { minimum: 1, maximum: 1 },
    ok: { dry_run: true, plan: { action: "ready", key: "github:a/b#1", argv: ["gh"] } },
  });
  const { exec, calls } = fakeExec({ exitCode: 0, stdout, stderr: "", timedOut: false });
  const argv = ["/opt/bin/pohunek-work", "do", "github:a/b#1", "ready", "--project", "p", "--dry-run", "--json"];
  const result = await runPreview(exec, argv, 60_000);
  expect(calls).toEqual([{ argv, options: { timeoutMs: 60_000 } }]);
  expect(result.outcome?.kind).toBe("ok");
});

function fakeTerminal(events: string[]): Terminal {
  return {
    start: () => events.push("start"),
    size: () => ({ columns: 80, rows: 24 }),
    draw: () => events.push("draw"),
    bell: () => events.push("bell"),
    handover: async (body) => {
      events.push("handover");
      try {
        return await body();
      } finally {
        events.push("handover-end");
      }
    },
    awaitEnter: (prompt) => {
      events.push(`enter:${prompt}`);
      return Promise.resolve();
    },
    resume: () => events.push("resume"),
    restore: () => events.push("restore"),
  };
}

describe("runHandover", () => {
  const argv = ["/opt/bin/pohunek-work", "do", "linear:A-1", "implement", "--project", "p", "--json"];

  test("write: stdout piped, Enter prompt, then resume", async () => {
    const events: string[] = [];
    const spawn: ForegroundSpawn = (given, stdout) => {
      events.push(`spawn:${given.join(" ")}:${stdout}`);
      return Promise.resolve({ exitCode: 0, signal: null, stdout: "{}" });
    };
    const exit = await runHandover(fakeTerminal(events), spawn, "write", argv);
    expect(exit).toEqual({ exitCode: 0, signal: null, stdout: "{}", spawnError: null });
    expect(events).toEqual(["handover", `spawn:${argv.join(" ")}:pipe`, `enter:${RETURN_PROMPT}`, "handover-end", "resume"]);
  });

  test("attach: stdout inherited; a clean detach returns without the Enter prompt", async () => {
    const events: string[] = [];
    const spawn: ForegroundSpawn = (_argv, stdout) => {
      events.push(`spawn:${stdout}`);
      return Promise.resolve({ exitCode: 0, signal: null, stdout: "" });
    };
    await runHandover(fakeTerminal(events), spawn, "attach", ["/x", "do", "linear:A-1", "attach", "--project", "p"]);
    expect(events).toEqual(["handover", "spawn:inherit", "handover-end", "resume"]);
  });

  test("attach that fails asks for Enter so its message can be read", async () => {
    const events: string[] = [];
    const spawn: ForegroundSpawn = () => Promise.resolve({ exitCode: 2, signal: null, stdout: "" });
    await runHandover(fakeTerminal(events), spawn, "attach", ["/x"]);
    expect(events).toContain(`enter:${RETURN_PROMPT}`);
  });

  test("a binary that cannot start is reported, and the screen comes back", async () => {
    const events: string[] = [];
    const spawn: ForegroundSpawn = () => Promise.reject(new SpawnError("/missing", new Error("ENOENT")));
    const exit = await runHandover(fakeTerminal(events), spawn, "write", argv);
    expect(exit).toEqual({ exitCode: null, signal: null, stdout: "", spawnError: "cannot start /missing" });
    expect(events.at(-1)).toBe("resume");
  });

  test("an unexpected failure still resumes the screen", async () => {
    const events: string[] = [];
    const spawn: ForegroundSpawn = () => Promise.reject(new TypeError("boom"));
    const failure = await runHandover(fakeTerminal(events), spawn, "write", argv).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(events.at(-1)).toBe("resume");
  });
});

describe("spawnForeground (real children, same process group)", () => {
  test("pipes stdout of a write child and reports its exit code", async () => {
    expect(await spawnForeground(["/bin/sh", "-c", "printf '{\"x\":1}'; exit 3"], "pipe")).toEqual({ exitCode: 3, signal: null, stdout: '{"x":1}' });
  });

  test("a child killed by a signal has no exit code", async () => {
    const exit = await spawnForeground(["/bin/sh", "-c", "kill -INT $$"], "pipe");
    expect(exit).toEqual({ exitCode: null, signal: "SIGINT", stdout: "" });
  });

  test("the child is not detached: it shares the TUI's process group", async () => {
    const exit = await spawnForeground(["/bin/sh", "-c", "ps -o pgid= -p $$"], "pipe");
    const own = await spawnForeground(["/bin/sh", "-c", `ps -o pgid= -p ${process.pid.toString()}`], "pipe");
    expect(exit.stdout.trim()).toBe(own.stdout.trim());
  });

  test("a missing binary is a SpawnError", async () => {
    expect(await spawnForeground(["/nonexistent/pohunek-work"], "inherit").then(() => null, (error: unknown) => error)).toBeInstanceOf(SpawnError);
  });
});

describe("openUrl", () => {
  test("passes the href as one argv element after open_command", () => {
    const calls: (readonly string[])[] = [];
    const href = "https://github.com/a/b/pull/1?x=$(id)&y=;rm";
    expect(openUrl((argv) => calls.push(argv), "/usr/bin/xdg-open", href)).toBeNull();
    expect(calls).toEqual([["/usr/bin/xdg-open", href]]);
  });

  test("an opener that cannot start yields a message", () => {
    const failing = (): void => {
      throw new SpawnError("/usr/bin/xdg-open", new Error("ENOENT"));
    };
    expect(openUrl(failing, "/usr/bin/xdg-open", "https://github.com/")).toBe("cannot start /usr/bin/xdg-open");
  });

  test("spawnDetached starts a real child and refuses a missing binary", () => {
    expect(() => {
      spawnDetached(["/bin/true", "https://github.com/"]);
    }).not.toThrow();
    expect(() => {
      spawnDetached(["/nonexistent/opener", "https://github.com/"]);
    }).toThrow(SpawnError);
  });
});
