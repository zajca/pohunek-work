import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSwaySnippet } from "../../src/setup/install.ts";
import type { SetupPaths } from "../../src/setup/paths.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pw-sway-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Characters that break an unquoted path in sway's config parser or in sh.
const NASTY_DIRS = [
  "with space",
  "it's",
  'say "hi"',
  "dollar $mod $HOME ${x}",
  "back`tick`",
  "semi;colon,comma",
  "hash # {brace}",
  "back\\slash",
  "all it's \"q\" $mod `z` a;b,c #h {x} \\b",
];

function pathsIn(dir: string): SetupPaths {
  return { configHome: root, configDir: root, dataDir: root, launcherBinDir: dir, swayConfigDir: root };
}

/** The text after `exec ` of the binding line, which sway hands to `sh -c` unchanged. */
function execText(snippet: string, keybind: string): string {
  const line = snippet.split("\n").find((candidate) => candidate.startsWith(`bindsym ${keybind} `));
  if (line === undefined) throw new Error(`no binding for ${keybind} in ${snippet}`);
  return line.slice(`bindsym ${keybind} exec `.length);
}

async function recorder(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const out = join(root, `out.${name}`);
  await writeFile(join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$0" "$#" "$@" > '${out}'\n`);
  await chmod(join(dir, name), 0o755);
  return out;
}

async function run(command: string): Promise<number | null> {
  const child = Bun.spawn(["sh", "-c", command], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  expect(stderr).toBe("");
  return child.exitCode;
}

test("the generated switcher command line runs the installed script from every nasty directory", async () => {
  for (const [index, name] of NASTY_DIRS.entries()) {
    const dir = join(root, `${String(index)} ${name}`);
    const out = await recorder(dir, "pohunek-rofi");
    await recorder(dir, "pohunek-rofi-issue");
    const newSession = await recorder(dir, "pohunek-new-session");
    const snippet = buildSwaySnippet(pathsIn(dir), { keybind: "$mod+p", issueKeybind: "$mod+i", issueProject: null, issueSource: null });
    expect(await run(execText(snippet, "$mod+p"))).toBe(0);
    expect((await readFile(out, "utf8")).split("\n").slice(0, 2)).toEqual([join(dir, "pohunek-rofi"), "0"]);
    expect(await run(execText(snippet, "$mod+n"))).toBe(0);
    expect((await readFile(newSession, "utf8")).split("\n").slice(0, 2)).toEqual([join(dir, "pohunek-new-session"), "0"]);
  }
});

test("the generated issue command line passes the project and source arguments unchanged", async () => {
  const projects = ["ui", "my proj", "it's", 'q"uote', "$mod ${x} `z`", "a;b,c #d", "back\\slash"];
  for (const [index, name] of NASTY_DIRS.entries()) {
    const project = projects[index % projects.length] ?? "ui";
    const dir = join(root, `${String(index)} ${name}`);
    await recorder(dir, "pohunek-rofi");
    const out = await recorder(dir, "pohunek-rofi-issue");
    const snippet = buildSwaySnippet(pathsIn(dir), { keybind: "$mod+p", issueKeybind: "$mod+i", issueProject: project, issueSource: "github" });
    expect(await run(execText(snippet, "$mod+i"))).toBe(0);
    expect((await readFile(out, "utf8")).split("\n").slice(0, 4)).toEqual([join(dir, "pohunek-rofi-issue"), "2", project, "github"]);
  }
});
