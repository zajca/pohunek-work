import { describe, expect, test } from "bun:test";
import {
  createTerminal,
  decodeKeys,
  signalExitCode,
  type ProcessHooks,
  type TerminatingSignal,
  type TtyInput,
  type TtyOutput,
} from "../../src/tui/terminal.ts";

const ESC = "\u001b";

describe("decodeKeys", () => {
  test("arrows in normal and application mode", () => {
    expect(decodeKeys(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D${ESC}OA${ESC}OB`).map((k) => k.kind)).toEqual([
      "up",
      "down",
      "right",
      "left",
      "up",
      "down",
    ]);
  });

  test("paging, home, end and back-tab", () => {
    expect(decodeKeys(`${ESC}[5~${ESC}[6~${ESC}[H${ESC}[1~${ESC}[F${ESC}[4~${ESC}[Z`).map((k) => k.kind)).toEqual([
      "pageUp",
      "pageDown",
      "home",
      "home",
      "end",
      "end",
      "backTab",
    ]);
  });

  test("a lone Esc at the end of a read is the Esc key", () => {
    expect(decodeKeys(ESC)).toEqual([{ kind: "escape" }]);
    expect(decodeKeys(`${ESC}${ESC}`)).toEqual([{ kind: "escape" }, { kind: "escape" }]);
  });

  test("control keys", () => {
    expect(decodeKeys("\r\n\t\u007f\b\u0003").map((k) => k.kind)).toEqual([
      "enter",
      "enter",
      "tab",
      "backspace",
      "backspace",
      "ctrlC",
    ]);
  });

  test("printable ASCII becomes char keys", () => {
    expect(decodeKeys("jG/ ")).toEqual([
      { kind: "char", char: "j" },
      { kind: "char", char: "G" },
      { kind: "char", char: "/" },
      { kind: "char", char: " " },
    ]);
  });

  test("unknown sequences, Alt combinations, other control bytes and non-ASCII are dropped", () => {
    expect(decodeKeys(`${ESC}[1;5A${ESC}[200~${ESC}x\u0001\u001czž😀q`)).toEqual([
      { kind: "char", char: "z" },
      { kind: "char", char: "q" },
    ]);
  });

  test("a truncated sequence is dropped without eating later keys", () => {
    expect(decodeKeys(`${ESC}[12`)).toEqual([]);
    expect(decodeKeys(`${ESC}[\u0001j`)).toEqual([{ kind: "char", char: "j" }]);
  });
});

interface Fake {
  readonly events: string[];
  readonly input: TtyInput & { emit(data: string): void };
  readonly output: TtyOutput & { setSize(columns: number, rows: number): void };
  readonly hooks: ProcessHooks & { fire(signal: "SIGINT" | TerminatingSignal): void; count(signal: string): number };
}

function fake(): Fake {
  const events: string[] = [];
  const dataListeners = new Set<(chunk: Buffer | string) => void>();
  const resizeListeners = new Set<() => void>();
  const signalListeners = new Map<string, Set<() => void>>();
  let columns = 80;
  let rows = 24;
  const describeWrite = (text: string): string =>
    text.replaceAll(ESC, "ESC").replaceAll("\r\n", "|").replaceAll("\u0007", "BEL");
  return {
    events,
    input: {
      setRawMode: (mode) => events.push(`raw:${String(mode)}`),
      on: (_event, listener) => dataListeners.add(listener),
      off: (_event, listener) => dataListeners.delete(listener),
      pause: () => events.push("pause"),
      resume: () => events.push("resume"),
      emit: (data) => {
        for (const listener of [...dataListeners]) listener(data);
      },
    },
    output: {
      write: (text) => events.push(`write:${describeWrite(text)}`),
      get columns() {
        return columns;
      },
      get rows() {
        return rows;
      },
      on: (_event, listener) => resizeListeners.add(listener),
      off: (_event, listener) => resizeListeners.delete(listener),
      setSize: (c, r) => {
        columns = c;
        rows = r;
        for (const listener of resizeListeners) listener();
      },
    },
    hooks: {
      on: (event, listener) => {
        const set = signalListeners.get(event) ?? new Set();
        set.add(listener);
        signalListeners.set(event, set);
        events.push(`on:${event}`);
      },
      off: (event, listener) => {
        signalListeners.get(event)?.delete(listener);
        events.push(`off:${event}`);
      },
      exit: (code) => {
        events.push(`exit:${code.toString()}`);
        throw new Error(`exit ${code.toString()}`);
      },
      fire: (signal) => {
        for (const listener of [...(signalListeners.get(signal) ?? [])]) listener();
      },
      count: (signal) => signalListeners.get(signal)?.size ?? 0,
    },
  };
}

const ENTER = "write:ESC[?1049hESC[?25l";
const LEAVE = "write:ESC[?25hESC[?1049l";

function started(f: Fake, keys: string[] = [], signals: string[] = []): ReturnType<typeof createTerminal> {
  const terminal = createTerminal(f.input, f.output, f.hooks);
  terminal.start({
    onKey: (key) => keys.push(key.kind === "char" ? key.char : key.kind),
    onResize: (size) => keys.push(`resize:${size.columns.toString()}x${size.rows.toString()}`),
    onSignal: (signal) => signals.push(signal),
  });
  return terminal;
}

describe("terminal driver", () => {
  test("start enters raw mode, then the alternate screen with the cursor hidden", () => {
    const f = fake();
    started(f);
    expect(f.events).toEqual(["on:SIGTERM", "on:SIGHUP", "raw:true", ENTER, "resume"]);
  });

  test("keys and resizes reach the handlers", () => {
    const f = fake();
    const keys: string[] = [];
    started(f, keys);
    f.input.emit(`j${ESC}[B`);
    f.output.setSize(100, 30);
    expect(keys).toEqual(["j", "down", "resize:100x30"]);
  });

  test("draw homes the cursor, pads each line to the width and clears below", () => {
    const f = fake();
    const terminal = started(f);
    f.output.setSize(5, 3);
    f.events.length = 0;
    terminal.draw(["ab", "cdefg"]);
    expect(f.events).toEqual(["write:ESC[Hab   |cdefgESC[J"]);
  });

  test("handover: leave the screen first, SIGINT ignored only during the child", async () => {
    const f = fake();
    const keys: string[] = [];
    const terminal = started(f, keys);
    f.events.length = 0;
    let duringChild: string[] = [];
    await terminal.handover(async () => {
      duringChild = [...f.events];
      expect(f.hooks.count("SIGINT")).toBe(1);
      f.hooks.fire("SIGINT");
      f.input.emit("x");
      await Promise.resolve();
    });
    expect(duringChild).toEqual(["pause", "raw:false", LEAVE, "on:SIGINT"]);
    expect(f.hooks.count("SIGINT")).toBe(0);
    expect(keys).toEqual([]);
    terminal.draw(["hidden"]);
    expect(f.events.some((event) => event.includes("hidden"))).toBe(false);
    f.events.length = 0;
    terminal.resume();
    expect(f.events).toEqual(["raw:true", ENTER, "resume"]);
    f.input.emit("k");
    expect(keys).toEqual(["k"]);
  });

  test("the SIGINT handler is removed when the child throws", async () => {
    const f = fake();
    const terminal = started(f);
    const failure = await terminal.handover(() => Promise.reject(new Error("boom"))).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(f.hooks.count("SIGINT")).toBe(0);
  });

  test("awaitEnter discards bytes up to Enter and never delivers them as keys", async () => {
    const f = fake();
    const keys: string[] = [];
    const terminal = started(f, keys);
    await terminal.handover(async () => {
      const waiting = terminal.awaitEnter("press Enter to return");
      f.input.emit("zz");
      f.input.emit("q\r");
      await waiting;
    });
    terminal.resume();
    expect(keys).toEqual([]);
    expect(f.events).toContain("write:press Enter to return");
  });

  test("restore leaves raw mode and the alternate screen once", () => {
    const f = fake();
    const terminal = started(f);
    f.events.length = 0;
    terminal.restore();
    terminal.restore();
    expect(f.events).toEqual(["off:SIGTERM", "off:SIGHUP", "pause", "raw:false", LEAVE]);
  });

  test("restore during a handover resets the mode without re-entering the screen", async () => {
    const f = fake();
    const terminal = started(f);
    await terminal.handover(() => {
      f.events.length = 0;
      terminal.restore();
      return Promise.resolve();
    });
    expect(f.events).toEqual(["off:SIGTERM", "off:SIGHUP", "raw:false", "pause", "off:SIGINT"]);
  });

  test.each(["SIGTERM", "SIGHUP"] as const)("%s restores the terminal, reports and exits with 128+n", (signal) => {
    const f = fake();
    const signals: string[] = [];
    started(f, [], signals);
    f.events.length = 0;
    expect(() => {
      f.hooks.fire(signal);
    }).toThrow("exit");
    expect(f.events.slice(0, 5)).toEqual(["off:SIGTERM", "off:SIGHUP", "pause", "raw:false", LEAVE]);
    expect(f.events.at(-1)).toBe(`exit:${signalExitCode(signal).toString()}`);
    expect(signals).toEqual([signal]);
  });

  test("signal exit codes follow the shell convention", () => {
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGHUP")).toBe(129);
  });
});
