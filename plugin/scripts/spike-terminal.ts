#!/usr/bin/env bun
// T0 spike of the TUI terminal driver (docs/tui-plan.md section 9). Build it
// with `bun build --compile` and run it in a real terminal or a pseudo-terminal:
//
//   bun build --compile scripts/spike-terminal.ts --outfile <scratch>/spike-terminal
//   <scratch>/spike-terminal <absolute pohunek bin> <session id>
//
// Keys: any key is decoded and shown; `y` hands the terminal to a child that
// asks [y/N] the way `do` does; `t` hands it to `pohunek attach <session id>`;
// `e` throws to check the restore on an uncaught error; `q` or Ctrl-C quits.
// `<binary> child-prompt` is the child side of `y`.
import { createTerminal, type Key } from "../src/tui/terminal.ts";

async function childPrompt(): Promise<number> {
  process.stderr.write("Run this command? [y/N] ");
  for await (const line of console) {
    const yes = /^y(es)?$/i.test(line.trim());
    process.stdout.write(`child answer: ${yes ? "yes" : "no"}\n`);
    return yes ? 0 : 1;
  }
  process.stdout.write("child answer: eof\n");
  return 1;
}

function describe(key: Key): string {
  return key.kind === "char" ? `char:${key.char}` : key.kind;
}

async function spike(pohunekBin: string | undefined, sessionId: string | undefined): Promise<number> {
  const self = process.execPath;
  const terminal = createTerminal(process.stdin, process.stdout, process);
  const keys: string[] = [];
  let note = "ready";
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const render = (): void => {
    const { columns, rows } = terminal.size();
    terminal.draw([
      `SPIKE size=${columns.toString()}x${rows.toString()} keys=${keys.length.toString()}`,
      `last=${keys.slice(-6).join(",")}`,
      `note=${note}`,
      "y: prompt child  t: attach  e: throw  q: quit",
    ]);
  };

  const runChild = async (argv: readonly string[], askEnter: boolean): Promise<void> => {
    const outcome = await terminal.handover(async () => {
      const child = Bun.spawn([...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      await child.exited;
      const result = `exit=${String(child.exitCode)} signal=${String(child.signalCode)}`;
      process.stdout.write(`HANDOVER END ${result}\n`);
      if (askEnter || child.exitCode !== 0) await terminal.awaitEnter("press Enter to return");
      return result;
    });
    terminal.resume();
    note = `back ${outcome}`;
    render();
  };

  const onKey = (key: Key): void => {
    keys.push(describe(key));
    if (key.kind === "ctrlC" || (key.kind === "char" && key.char === "q")) {
      finish(0);
      return;
    }
    if (key.kind === "char" && key.char === "e") throw new Error("spike: thrown on purpose");
    if (key.kind === "char" && key.char === "y") {
      void runChild([self, "child-prompt"], true);
      return;
    }
    if (key.kind === "char" && key.char === "t") {
      if (pohunekBin === undefined || sessionId === undefined) {
        note = "no session given";
      } else {
        void runChild([pohunekBin, "attach", sessionId], false);
        return;
      }
    }
    render();
  };

  process.on("uncaughtException", (error) => {
    terminal.restore();
    process.stderr.write(`SPIKE uncaught: ${error.message}\n`);
    process.exit(70);
  });
  terminal.start({
    onKey,
    onResize: () => {
      note = "resized";
      render();
    },
    onSignal: (signal) => {
      process.stderr.write(`SPIKE restored after ${signal}\n`);
    },
  });
  render();
  try {
    return await done;
  } finally {
    terminal.restore();
  }
}

const [first, second] = process.argv.slice(2);
process.exitCode = first === "child-prompt" ? await childPrompt() : await spike(first, second);
