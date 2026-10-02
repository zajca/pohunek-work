// do's plan text on the terminal is strict ASCII; its JSON and the prompt on stdin are not changed.
import { expect, test } from "bun:test";
import { runDo } from "../../src/commands/do.ts";
import { issue } from "../rules/builders.ts";
import { baseConfig, ok, options, setup } from "./harness.ts";

const TITLE = "Oprava žluťoučkého koňe \u001b]52;c;cHduZWQ=\u0007 \u202Eevil";
// The prompt already turned ESC and BEL into spaces; the display turns the bidi override into ?.
const ASCII_TITLE = "Oprava zlutouckeho kone  ]52;c;cHduZWQ=  ?evil";

async function captureStderr(body: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

test("the plan shown before the y/N question is strict ASCII", async () => {
  const { deps, launches } = setup({ issues: ok("linear", [issue({ title: TITLE })]), confirm: () => Promise.resolve(true) });
  const shown = await captureStderr(() => runDo(baseConfig, options({ yes: false, json: true }), deps));
  expect(/^[\x20-\x7e\n]*$/.test(shown)).toBe(true);
  expect(shown).toContain(`title: ${ASCII_TITLE}`);
  // The agent still gets the title with its diacritics (control characters only become spaces).
  expect(launches[0]?.stdin).toContain("Oprava žluťoučkého koňe");
});

test("a text dry run is strict ASCII; the JSON dry run keeps the prompt as sent", async () => {
  const { deps } = setup({ issues: ok("linear", [issue({ title: TITLE })]) });
  const text = await runDo(baseConfig, options({ dryRun: true, yes: false, json: false }), deps);
  expect(/^[\x20-\x7e\n]*$/.test(text.stdout)).toBe(true);
  expect(text.stdout).toContain(ASCII_TITLE);
  const json = await runDo(baseConfig, options({ dryRun: true, yes: false, json: true }), deps);
  const prompt = (JSON.parse(json.stdout) as { ok: { plan: { prompt: string } } }).ok.plan.prompt;
  expect(prompt).toContain("žluťoučkého");
});
