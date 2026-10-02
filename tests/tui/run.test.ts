import { expect, test } from "bun:test";
import { runTui, settingsFrom, type Timers, type TuiDeps } from "../../src/commands/tui.ts";
import type { Logger } from "../../src/log.ts";
import type { Key, Size, Terminal, TerminalHandlers } from "../../src/tui/terminal.ts";
import type { TuiConfig } from "../../src/types/config.ts";
import type { Exec, ExecOptions, ExecResult } from "../../src/util/exec.ts";
import { envelopeText, payload, RULE_ROWS } from "./builders.ts";

const CONFIG: TuiConfig = {
  selfBin: "/opt/bin/pohunek-work",
  refreshIntervalSecs: 300,
  listTimeoutMs: 60_000,
  staleAfterSecs: 900,
  initialView: "mine",
  bellOnTransition: false,
  openCommand: "/usr/bin/xdg-open",
  openUrlHosts: ["github.com"],
  stderrMaxLines: 10,
  detailMinWidth: 120,
};

interface Harness {
  readonly deps: TuiDeps;
  readonly frames: string[][];
  readonly calls: { argv: readonly string[]; options: ExecOptions }[];
  readonly events: string[];
  readonly logged: { event: string; fields: unknown }[];
  readonly timers: { ms: number; callback: () => void; cleared: boolean }[];
  readonly spawned: { argv: readonly string[]; stdout: string }[];
  readonly opened: (readonly string[])[];
  press(key: Key): void;
  settle(): Promise<void>;
}

const handoverStdout = JSON.stringify({
  cli_version: "0.1.0",
  protocol: { minimum: 1, maximum: 1 },
  err: { class: "action", code: "confirmation_required", msg: "not confirmed; nothing was executed" },
});

function harness(results: (ExecResult | Error)[], size: Size = { columns: 80, rows: 24 }): Harness {
  const frames: string[][] = [];
  const calls: { argv: readonly string[]; options: ExecOptions }[] = [];
  const events: string[] = [];
  const logged: { event: string; fields: unknown }[] = [];
  const timers: { ms: number; callback: () => void; cleared: boolean }[] = [];
  const spawned: { argv: readonly string[]; stdout: string }[] = [];
  const opened: (readonly string[])[] = [];
  let handlers: TerminalHandlers | null = null;
  const terminal: Terminal = {
    start: (next) => {
      handlers = next;
      events.push("start");
    },
    size: () => size,
    draw: (lines) => frames.push([...lines]),
    bell: () => events.push("bell"),
    handover: (body) => {
      events.push("handover");
      return body();
    },
    awaitEnter: () => {
      events.push("awaitEnter");
      return Promise.resolve();
    },
    resume: () => events.push("resume"),
    restore: () => events.push("restore"),
  };
  const exec: Exec = (argv, options) => {
    calls.push({ argv, options });
    const result = results.shift();
    if (result === undefined) return new Promise(() => undefined);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  const logger: Logger = {
    info: (event, fields) => logged.push({ event, fields }),
    error: (event, fields) => logged.push({ event, fields }),
    sourceResult: () => undefined,
    failure: () => null,
    close: () => Promise.resolve(),
  };
  const fakeTimers: Timers = {
    setTimeout: (callback, ms) => {
      const timer = { ms, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return {
    deps: {
      config: CONFIG,
      cliVersion: "0.1.0",
      logger,
      terminal,
      exec,
      now: () => 1_000_000,
      timers: fakeTimers,
      spawnForeground: (argv, stdout) => {
        spawned.push({ argv, stdout });
        return Promise.resolve({ exitCode: 2, signal: null, stdout: handoverStdout });
      },
      spawnDetached: (argv) => {
        opened.push(argv);
      },
      report: (message) => events.push(`report:${message}`),
    },
    frames,
    calls,
    events,
    logged,
    timers,
    spawned,
    opened,
    press: (key) => handlers?.onKey(key),
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const LIST_OK: ExecResult = { exitCode: 0, stdout: envelopeText(payload(RULE_ROWS)), stderr: "", timedOut: false };

test("settings come from [tui] in milliseconds", () => {
  expect(settingsFrom(CONFIG, "0.1.0")).toEqual({
    selfBin: "/opt/bin/pohunek-work",
    cliVersion: "0.1.0",
    refreshIntervalMs: 300_000,
    staleAfterMs: 900_000,
    initialView: "mine",
    bellOnTransition: false,
    stderrMaxLines: 10,
    detailMinWidth: 120,
    openUrlHosts: ["github.com"],
  });
});

test("starts, refreshes with the exact argv, renders rows, schedules the next refresh and quits on q", async () => {
  const h = harness([LIST_OK]);
  const running = runTui(h.deps);
  await h.settle();
  expect(h.calls).toEqual([{ argv: ["/opt/bin/pohunek-work", "list", "--json"], options: { timeoutMs: 60_000 } }]);
  expect(h.frames[0]?.join("\n")).toContain("loading...");
  expect(h.frames.at(-1)?.join("\n")).toContain("linear:DMD-101");
  const refresh = h.timers.find((timer) => timer.ms === 300_000);
  expect(refresh).toBeDefined();
  expect(h.logged.map((entry) => entry.event)).toEqual(["tui_start", "refresh_done"]);
  expect(h.logged[1]?.fields).toEqual({
    duration_ms: 0,
    exit_code: 0,
    timed_out: false,
    outcome: "ok",
    items: RULE_ROWS.length,
    source_failures: 0,
  });

  refresh?.callback();
  await h.settle();
  expect(h.calls).toHaveLength(2);

  h.press({ kind: "char", char: "q" });
  expect(await running).toBe(0);
  expect(h.events).toEqual(["start", "restore"]);
  expect(h.timers.every((timer) => timer.cleared || timer.ms !== 300_000 || timer === refresh)).toBe(true);
  expect(h.logged.at(-1)).toEqual({ event: "terminal_restore", fields: { reason: "exit" } });
});

test("an internal error restores the terminal first, then reports and exits 2", async () => {
  const h = harness([new TypeError("decoder exploded")]);
  const code = await runTui(h.deps);
  expect(code).toBe(2);
  expect(h.events).toEqual(["start", "restore", "report:pohunek-work tui: internal error: TypeError: decoder exploded"]);
  expect(h.logged.some((entry) => entry.event === "tui_error")).toBe(true);
});

test("titles, bodies and child stdout are never logged", async () => {
  const h = harness([LIST_OK]);
  const running = runTui(h.deps);
  await h.settle();
  h.press({ kind: "ctrlC" });
  await running;
  const text = JSON.stringify(h.logged);
  for (const item of RULE_ROWS) {
    if (item.issue !== null) expect(text).not.toContain(item.issue.title);
  }
});

test("Enter hands over to do with the exact argv, logs start and end, then refreshes", async () => {
  const h = harness([LIST_OK, LIST_OK]);
  const running = runTui(h.deps);
  await h.settle();
  // initial_view mine: the first row is github:keboola/connection#9003 (review).
  h.press({ kind: "enter" });
  await h.settle();
  expect(h.spawned).toEqual([
    {
      argv: ["/opt/bin/pohunek-work", "do", "github:keboola/connection#9003", "review", "--project", "connection", "--json"],
      stdout: "pipe",
    },
  ]);
  expect(h.events).toEqual(["start", "handover", "awaitEnter", "resume"]);
  expect(h.calls).toHaveLength(2);
  const events = h.logged.map((entry) => entry.event);
  expect(events).toContain("handover_start");
  expect(h.logged.find((entry) => entry.event === "handover_end")?.fields).toEqual({
    key: "github:keboola/connection#9003",
    action: "review",
    exit_code: 2,
    signal: null,
    spawn_error: null,
    refusal: "confirmation_required",
  });
  expect(h.frames.at(-1)?.join("\n")).toContain("cancelled, nothing was executed");
  h.press({ kind: "char", char: "q" });
  expect(await running).toBe(0);
});

test("o opens the PR URL through open_command and logs only key and host", async () => {
  const h = harness([LIST_OK]);
  const running = runTui(h.deps);
  await h.settle();
  h.press({ kind: "char", char: "o" });
  expect(h.opened).toEqual([["/usr/bin/xdg-open", "https://github.com/keboola/connection/pull/9003"]]);
  expect(h.logged.find((entry) => entry.event === "open_url")?.fields).toEqual({
    key: "github:keboola/connection#9003",
    host: "github.com",
    error: null,
  });
  h.press({ kind: "char", char: "q" });
  await running;
});

test("p runs the preview child piped with the list timeout", async () => {
  const preview: ExecResult = {
    exitCode: 0,
    stdout: JSON.stringify({ cli_version: "0.1.0", protocol: { minimum: 1, maximum: 1 }, ok: { dry_run: true, plan: { action: "review", key: "k", argv: ["/bin/pohunek"] } } }),
    stderr: "",
    timedOut: false,
  };
  const h = harness([LIST_OK, preview], { columns: 160, rows: 30 });
  const running = runTui(h.deps);
  await h.settle();
  h.press({ kind: "char", char: "p" });
  await h.settle();
  expect(h.calls[1]).toEqual({
    argv: ["/opt/bin/pohunek-work", "do", "github:keboola/connection#9003", "review", "--project", "connection", "--dry-run", "--json"],
    options: { timeoutMs: 60_000 },
  });
  expect(h.frames.at(-1)?.join("\n")).toContain("--- preview: review (dry run, nothing executed)");
  h.press({ kind: "char", char: "q" });
  await running;
});
