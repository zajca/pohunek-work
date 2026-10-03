import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLauncherTerminal, resolveExecutable, runLauncherChecks, type LauncherCheck } from "../src/launcher-doctor.ts";

let root = "";
let bin = "";
let env: Record<string, string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pw-ldoctor-"));
  bin = join(root, "bin");
  await mkdir(bin);
  env = { PATH: bin, XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function tool(name: string, mode = 0o755): Promise<string> {
  const path = join(bin, name);
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, mode);
  return path;
}

function byName(checks: readonly LauncherCheck[], name: string): LauncherCheck {
  const found = checks.find((check) => check.name === name);
  if (found === undefined) throw new Error(`no check ${name} in ${checks.map((check) => check.name).join(",")}`);
  return found;
}

test("linux runs the launcher checks in a fixed order", async () => {
  const checks = await runLauncherChecks({ env, platform: "linux" });
  expect(checks.map((check) => check.name)).toEqual([
    "bin:rofi",
    "bin:swaymsg",
    "bin:python3",
    "terminal",
    "launcher_scripts",
    "sway_include",
  ]);
});

test("a missing binary is advisory with the not-found message, a present one reports its path", async () => {
  const rofi = await tool("rofi");
  const checks = await runLauncherChecks({ env, platform: "linux" });
  expect(byName(checks, "bin:rofi")).toEqual({ name: "bin:rofi", ok: true, message: `found at ${rofi}` });
  expect(byName(checks, "bin:swaymsg")).toEqual({ name: "bin:swaymsg", ok: false, message: "'swaymsg' not found on PATH" });
});

test("a non-executable file and relative or empty PATH entries do not resolve", async () => {
  await tool("rofi", 0o644);
  expect(await resolveExecutable("rofi", bin)).toBeNull();
  await tool("swaymsg");
  expect(await resolveExecutable("swaymsg", `::relative/dir:${bin}`)).toBe(join(bin, "swaymsg"));
  expect(await resolveExecutable("swaymsg", "relative:")).toBeNull();
  expect(await resolveExecutable("swaymsg", undefined)).toBeNull();
});

test("a name with a path separator must be an absolute executable file", async () => {
  const path = await tool("custom");
  expect(await resolveExecutable(path, undefined)).toBe(path);
  expect(await resolveExecutable("bin/custom", bin)).toBeNull();
  expect(await resolveExecutable(join(root, "missing"), undefined)).toBeNull();
});

test("a symlinked executable resolves through the link", async () => {
  const target = await tool("real");
  await symlink(target, join(bin, "linked"));
  expect(await resolveExecutable("linked", bin)).toBe(join(bin, "linked"));
});

test("the terminal is advisory without TERMINAL and launcher.conf, ok with either", async () => {
  expect(byName(await runLauncherChecks({ env, platform: "linux" }), "terminal").ok).toBe(false);
  expect(byName(await runLauncherChecks({ env: { ...env, TERMINAL: "foot" }, platform: "linux" }), "terminal")).toEqual({
    name: "terminal",
    ok: true,
    message: "TERMINAL=foot",
  });
  expect(byName(await runLauncherChecks({ env: { ...env, TERMINAL: "" }, platform: "linux" }), "terminal").ok).toBe(false);

  await mkdir(join(root, "config", "pohunek"), { recursive: true });
  await writeFile(join(root, "config", "pohunek", "launcher.conf"), "host=local\nterminal=kitty\n");
  expect(byName(await runLauncherChecks({ env, platform: "linux" }), "terminal").message).toBe("terminal=kitty (launcher.conf)");
});

test("launcher.conf terminal parsing follows the launcher's lookup", () => {
  expect(parseLauncherTerminal("# c\n\nterminal = foot \nterminal=\n")).toBeNull();
  expect(parseLauncherTerminal("terminal=a\nterminal=b\n")).toBe("b");
  expect(parseLauncherTerminal("terminal=a\nbroken line\n")).toBeNull();
  expect(parseLauncherTerminal("host=local\n")).toBeNull();
});

test("launcher_scripts is ok once pohunek-rofi is installed", async () => {
  expect(byName(await runLauncherChecks({ env, platform: "linux" }), "launcher_scripts").message).toBe(
    "not installed; run 'pohunek-work setup scripts'",
  );
  const dir = join(root, "data", "pohunek", "bin");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pohunek-rofi"), "#!/bin/sh\n");
  expect(byName(await runLauncherChecks({ env, platform: "linux" }), "launcher_scripts")).toEqual({
    name: "launcher_scripts",
    ok: true,
    message: `installed at ${dir}`,
  });
});

test("sway_include is advisory when the config is absent, lacks the include or only comments it", async () => {
  const swayDir = join(root, "config", "sway");
  expect(byName(await runLauncherChecks({ env, platform: "linux" }), "sway_include").message).toBe(
    `sway config not found at ${join(swayDir, "config")}`,
  );
  await mkdir(swayDir, { recursive: true });
  await writeFile(join(swayDir, "config"), "# include ~/.config/sway/config.d/*\n");
  const commented = byName(await runLauncherChecks({ env, platform: "linux" }), "sway_include");
  expect(commented.ok).toBe(false);
  expect(commented.message).toBe(`add 'include ${swayDir}/config.d/*' to your sway config (see 'pohunek-work setup sway')`);
  await writeFile(join(swayDir, "config"), "include ~/.config/sway/config.d/*\n");
  expect(byName(await runLauncherChecks({ env, platform: "linux" }), "sway_include")).toEqual({
    name: "sway_include",
    ok: true,
    message: "sway config includes config.d",
  });
});

test("unresolvable install directories become one advisory check, not an error", async () => {
  const checks = await runLauncherChecks({ env: { PATH: bin }, platform: "linux" });
  expect(checks.map((check) => check.name)).toEqual(["bin:rofi", "bin:swaymsg", "bin:python3", "terminal", "launcher_paths"]);
  expect(byName(checks, "launcher_paths")).toEqual({
    name: "launcher_paths",
    ok: false,
    message: "cannot locate the launcher directories: missing XDG_DATA_HOME or HOME",
  });
});

test("macOS checks the terminal only and resolves terminal= as one executable", async () => {
  const none = await runLauncherChecks({ env, platform: "darwin" });
  expect(none.map((check) => check.name)).toEqual(["terminal"]);

  await mkdir(join(root, "config", "pohunek"), { recursive: true });
  const conf = join(root, "config", "pohunek", "launcher.conf");
  await writeFile(conf, "terminal=kitty -e\n");
  const split = byName(await runLauncherChecks({ env, platform: "darwin" }), "terminal");
  expect(split.ok).toBe(false);
  expect(split.message).toContain("does not resolve to one executable");

  await tool("kitty");
  await writeFile(conf, "terminal=kitty\n");
  const resolved = byName(await runLauncherChecks({ env, platform: "darwin" }), "terminal");
  expect(resolved.ok).toBe(true);
  expect(resolved.message).toStartWith("configured terminal 'kitty' resolves");
});
