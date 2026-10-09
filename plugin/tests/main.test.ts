import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const MANAGER_GUIDE = new URL("../prompts/manager-guide.md", import.meta.url).pathname;
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function run(args: readonly string[], configDir: string): Promise<{ code: number | null; out: string; err: string }> {
  const result = await exec(["bun", MAIN, ...args], {
    timeoutMs: 20_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: configDir,
      POHUNEK_WORK_CONFIG_DIR: join(configDir, "missing"),
      POHUNEK_WORK_STATE_DIR: join(configDir, "state"),
    },
  });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
}

test("an unknown option prints usage and exits 2 without a stack dump", async () => {
  const dir = await tempDir();
  const result = await run(["list", "--bogus"], dir);
  expect(result.code).toBe(2);
  expect(result.err).toContain("usage:");
  expect(result.err).not.toContain("node:internal");
});

test("a usage error under --json is a JSON error envelope on stdout", async () => {
  const dir = await tempDir();
  const result = await run(["list", "--json", "--bogus"], dir);
  expect(result.code).toBe(2);
  const envelope = JSON.parse(result.out) as { err: { class: string; code: string; msg: string } };
  expect(envelope.err.class).toBe("usage");
  expect(envelope.err.msg).toContain("usage:");
});

test("--finished-hours needs --mine and a positive whole number", async () => {
  const dir = await tempDir();
  for (const args of [["list", "--finished-hours", "6"], ["list", "--mine", "--finished-hours", "0"], ["list", "--mine", "--finished-hours", "x"], ["list", "--mine", "--finished-hours", "1.5"]]) {
    const result = await run(args, dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--finished-hours");
    expect(result.err).toContain("usage:");
  }
  const accepted = await run(["list", "--mine", "--finished-hours", "6", "--json"], dir);
  expect((JSON.parse(accepted.out) as { err: { code: string } }).err.code).toBe("config_invalid");
});

test("an unexpected positional argument is a usage error", async () => {
  const dir = await tempDir();
  expect((await run(["list", "foo"], dir)).code).toBe(2);
  expect((await run(["doctor", "--whatever"], dir)).code).toBe(2);
  expect((await run([], dir)).code).toBe(2);
});

test("do rejects unknown actions and options that do not apply, before reading the config", async () => {
  const dir = await tempDir();
  const cases: readonly (readonly string[])[] = [
    ["do", "ABC-1", "deploy"],
    ["do", "ABC-1", "ready", "--profile", "x"],
    ["do", "ABC-1", "attach", "--profile", "x"],
    ["do", "ABC-1", "cleanup", "--profile", "x"],
    ["do", "ABC-1", "cleanup", "--dry-run", "--yes"],
  ];
  for (const args of cases) {
    const result = await run(args, dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage:");
    expect(result.err).not.toContain("config.toml");
  }
  const attachJson = await run(["do", "ABC-1", "attach", "--json"], dir);
  expect(attachJson.code).toBe(2);
  const envelope = JSON.parse(attachJson.out) as { err: { class: string; msg: string } };
  expect(envelope.err.class).toBe("usage");
  expect(envelope.err.msg).toContain("attach takes --json only with --dry-run");
});

test("do takes one --project: a repeated one is a usage error before the config is read", async () => {
  const dir = await tempDir();
  const result = await run(["do", "ABC-1", "ready", "--project", "widgets", "--project", "gadgets"], dir);
  expect(result.code).toBe(2);
  expect(result.err).toContain("do takes one --project");
  expect(result.err).toContain("usage:");
  expect(result.err).not.toContain("config.toml");
  const json = await run(["do", "ABC-1", "ready", "--project", "widgets", "--project", "widgets", "--json"], dir);
  expect(json.code).toBe(2);
  const envelope = JSON.parse(json.out) as { err: { class: string; msg: string } };
  expect(envelope.err.class).toBe("usage");
  expect(envelope.err.msg).toContain("do takes one --project");
});

test("do accepts every action name and reaches the config", async () => {
  const dir = await tempDir();
  for (const action of ["fix-ci", "rebase", "review", "ready", "cleanup", "merge"]) {
    const result = await run(["do", "ABC-1", action, "--json"], dir);
    const envelope = JSON.parse(result.out) as { err: { code: string } };
    expect(envelope.err.code).toBe("config_invalid");
  }
  const attach = await run(["do", "ABC-1", "attach", "--dry-run", "--json"], dir);
  expect((JSON.parse(attach.out) as { err: { code: string } }).err.code).toBe("config_invalid");
});

test("a missing config exits 2 with a JSON error envelope under --json", async () => {
  const dir = await tempDir();
  const result = await run(["list", "--json"], dir);
  expect(result.code).toBe(2);
  const envelope = JSON.parse(result.out) as { err: { code: string; msg: string } };
  expect(envelope.err.code).toBe("config_invalid");
  expect(envelope.err.msg).toContain("config.toml");
});

test("tui: arguments are a usage error, a missing config names the file", async () => {
  const dir = await tempDir();
  const usage = await run(["tui", "--all"], dir);
  expect(usage.code).toBe(2);
  expect(usage.err).toContain("tui takes no arguments");
  const missing = await run(["tui"], dir);
  expect(missing.code).toBe(2);
  expect(missing.err).toContain("config.toml");
});

test("tui refuses without a terminal and leaves the screen alone", async () => {
  const dir = await tempDir();
  const result = await exec(["bun", MAIN, "tui"], {
    timeoutMs: 20_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: dir,
      POHUNEK_WORK_CONFIG_DIR: new URL("fixtures/config", import.meta.url).pathname,
      POHUNEK_WORK_STATE_DIR: join(dir, "state"),
    },
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("tui needs a terminal on stdin and stdout");
  expect(result.stdout).toBe("");
});

test("setup rejects unknown steps and options that do not apply", async () => {
  const dir = await tempDir();
  const cases: readonly (readonly string[])[] = [
    ["setup", "everything"],
    ["setup", "all"],
    ["setup", "scripts", "extra"],
    ["setup", "scripts", "--print"],
    ["setup", "config", "--keybind", "$mod+x"],
    ["setup", "config", "--new-session-keybind", "$mod+x"],
    ["setup", "sway", "--print", "--force"],
    ["setup", "scripts", "--issue-project", "ui"],
    ["setup", "sway", "--issue-keybind", "$mod+g"],
    ["setup", "sway", "--issue-project", "", "--issue-source", "github"],
    ["setup", "sway", "--issue-project", "ui"],
    ["setup", "sway", "--issue-source", "github"],
    ["setup", "sway", "--issue-project", "ui", "--issue-source", "jira"],
    ["setup", "config", "--issue-source", "github"],
  ];
  for (const args of cases) {
    const result = await run(args, dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage:");
  }
});

test("setup sway prints a custom standalone session binding", async () => {
  const dir = await tempDir();
  const result = await run(["setup", "sway", "--print", "--new-session-keybind", "$mod+Shift+n"], dir);
  expect(result.code).toBe(0);
  expect(result.out).toContain("bindsym $mod+Shift+n exec exec ");
  expect(result.out).toContain("pohunek-new-session");
});

test("setup installs into the XDG locations and reports JSON on stdout", async () => {
  const dir = await tempDir();
  const result = await exec(["bun", MAIN, "setup", "scripts", "--json"], {
    timeoutMs: 20_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CONFIG_HOME: join(dir, "config"),
    },
  });
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as { ok: { dir: string; files: { path: string; outcome: string }[] } };
  expect(envelope.ok.dir).toBe(join(dir, "data", "pohunek", "bin"));
  expect(envelope.ok.files.every((file) => file.outcome === "created")).toBe(true);
});

test("setup without a derivable home is a configuration error envelope", async () => {
  const result = await exec(["bun", MAIN, "setup", "--json"], { timeoutMs: 20_000, env: { PATH: process.env["PATH"] ?? "" } });
  expect(result.exitCode).toBe(2);
  const envelope = JSON.parse(result.stdout) as { err: { class: string; code: string; msg: string } };
  expect(envelope.err).toEqual({ class: "configuration", code: "setup_paths", msg: "missing XDG_DATA_HOME or HOME" });
});

test("doctor reports the launcher requirements as warnings next to the config failure", async () => {
  const dir = await tempDir();
  const result = await run(["doctor"], dir);
  expect(result.code).toBe(10);
  expect(result.out).toContain("FAIL config_invalid config");
  // The rofi/sway launcher is Linux-only: on macOS doctor checks the terminal and nothing else.
  if (process.platform === "darwin") {
    expect(result.out).not.toContain("launcher_scripts");
    expect(result.out).toMatch(/^(ok {2}|warn) \S+ terminal: /m);
  } else {
    expect(result.out).toMatch(/^warn warn launcher_scripts: not installed; run 'pohunek-work setup scripts'$/m);
  }
});

test("--include-ignored is accepted by list and do (parsing passes, the missing config is the next error)", async () => {
  const dir = await tempDir();
  for (const args of [["list", "--include-ignored", "--json"], ["do", "ABC-1", "review", "--include-ignored", "--json"]]) {
    const result = await run(args, dir);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.out) as { err: { class: string } };
    expect(envelope.err.class).toBe("configuration");
  }
});

test("--include-ignored is a usage error for commands that do not take it", async () => {
  const dir = await tempDir();
  const result = await run(["doctor", "--include-ignored"], dir);
  expect(result.code).toBe(2);
  expect(result.err).toContain("usage:");
});

test("manager guide prints the embedded guide unchanged and reads no config", async () => {
  const dir = await tempDir();
  const guide = await readFile(MANAGER_GUIDE, "utf8");
  const withoutConfig = await run(["manager", "guide"], dir);
  expect(withoutConfig.code).toBe(0);
  expect(withoutConfig.out).toBe(guide);
  expect(withoutConfig.err).toBe("");

  // run() points the config dir at <dir>/missing; a config there that cannot be parsed must not matter.
  await mkdir(join(dir, "missing"));
  await writeFile(join(dir, "missing", "config.toml"), "this is = = not toml\n");
  const broken = await run(["list", "--json"], dir);
  expect((JSON.parse(broken.out) as { err: { code: string } }).err.code).toBe("config_invalid");
  const withBrokenConfig = await run(["manager", "guide"], dir);
  expect(withBrokenConfig.code).toBe(0);
  expect(withBrokenConfig.out).toBe(guide);
  expect(withBrokenConfig.err).toBe("");
});

test("manager without a known subcommand, or guide with arguments, is a usage error before reading the config", async () => {
  const dir = await tempDir();
  const cases: readonly (readonly string[])[] = [
    ["manager"],
    ["manager", "bogus"],
    ["manager", "guide", "extra"],
    ["manager", "guide", "--all"],
  ];
  for (const args of cases) {
    const result = await run(args, dir);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("usage:");
    expect(result.err).toContain("pohunek-work manager guide");
    expect(result.err).not.toContain("config.toml");
  }
  const json = await run(["manager", "guide", "--json"], dir);
  expect(json.code).toBe(2);
  expect((JSON.parse(json.out) as { err: { class: string } }).err.class).toBe("usage");
});
