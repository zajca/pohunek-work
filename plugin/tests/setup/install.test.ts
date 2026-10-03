import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absent, failure } from "../helpers/failure.ts";
import { CONFIG_ASSETS, SCRIPT_ASSETS } from "../../src/setup/assets.ts";
import { installConfig, installScripts, installSway, SetupIoError, swayDropinPath, writeManaged, type SwayOptions } from "../../src/setup/install.ts";
import { resolveSetupPaths, type SetupPaths } from "../../src/setup/paths.ts";
import { OBSOLETE_SCRIPTS, SCRIPT_MODE } from "../../src/setup/settings.ts";

let root = "";
let paths: SetupPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pw-setup-"));
  paths = resolveSetupPaths({ XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function mode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

const NO_FORCE = { force: false };
const FORCE = { force: true };

test("installScripts creates every script executable, whatever the umask", async () => {
  const previous = process.umask(0o077);
  try {
    const result = await installScripts(paths, NO_FORCE);
    expect(result.files.map((file) => file.outcome)).toEqual(SCRIPT_ASSETS.map(() => "created"));
    for (const asset of SCRIPT_ASSETS) {
      const path = join(paths.launcherBinDir, asset.name);
      expect(await readFile(path, "utf8")).toBe(asset.body);
      expect(await mode(path)).toBe(SCRIPT_MODE);
    }
  } finally {
    process.umask(previous);
  }
});

test("a second run reports unchanged and a user edit is skipped, not replaced", async () => {
  await installScripts(paths, NO_FORCE);
  const again = await installScripts(paths, NO_FORCE);
  expect(again.files.every((file) => file.outcome === "unchanged")).toBe(true);

  const edited = join(paths.launcherBinDir, "pohunek-rofi");
  await writeFile(edited, "#!/bin/sh\necho mine\n");
  const third = await installScripts(paths, NO_FORCE);
  expect(third.files.find((file) => file.path === edited)?.outcome).toBe("skipped");
  expect(await readFile(edited, "utf8")).toBe("#!/bin/sh\necho mine\n");
});

test("identical content with a wrong mode is skipped until forced", async () => {
  await installScripts(paths, NO_FORCE);
  const path = join(paths.launcherBinDir, "lib.sh");
  await chmod(path, 0o644);
  expect((await installScripts(paths, NO_FORCE)).files.find((file) => file.path === path)?.outcome).toBe("skipped");
  expect((await installScripts(paths, FORCE)).files.find((file) => file.path === path)?.outcome).toBe("overwritten");
  expect(await mode(path)).toBe(SCRIPT_MODE);
});

test("force replaces differing files and leaves no temporary file behind", async () => {
  await installScripts(paths, NO_FORCE);
  const edited = join(paths.launcherBinDir, "pohunek-launch-pr");
  await writeFile(edited, "mine");
  const result = await installScripts(paths, FORCE);
  expect(result.files.find((file) => file.path === edited)?.outcome).toBe("overwritten");
  expect(result.files.find((file) => file.path.endsWith("lib.sh"))?.outcome).toBe("overwritten");
  expect(await readFile(edited, "utf8")).toBe(SCRIPT_ASSETS.find((asset) => asset.name === "pohunek-launch-pr")?.body ?? "");
  expect((await readdir(paths.launcherBinDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("force replaces a symbolic link itself and never writes through it", async () => {
  const victim = join(root, "victim");
  await writeFile(victim, "precious");
  await mkdir(paths.launcherBinDir, { recursive: true });
  const link = join(paths.launcherBinDir, "lib.sh");
  await symlink(victim, link);

  expect((await installScripts(paths, NO_FORCE)).files[0]?.outcome).toBe("skipped");
  await installScripts(paths, FORCE);

  expect(await readFile(victim, "utf8")).toBe("precious");
  expect((await lstat(link)).isSymbolicLink()).toBe(false);
});

test("obsolete scripts are removed only with force", async () => {
  await mkdir(paths.launcherBinDir, { recursive: true });
  const stale = join(paths.launcherBinDir, OBSOLETE_SCRIPTS[0] ?? "");
  await writeFile(stale, "#!/bin/sh\n");

  const kept = await installScripts(paths, NO_FORCE);
  expect(kept.removed).toEqual([]);
  expect((await lstat(stale)).isFile()).toBe(true);

  const forced = await installScripts(paths, FORCE);
  expect(forced.removed).toEqual([stale]);
  expect(await absent(lstat(stale))).toBe(true);
});

test("installConfig writes launcher.conf and the prompt templates, then protects edits", async () => {
  const first = await installConfig(paths, NO_FORCE);
  expect(first.files.map((file) => file.outcome)).toEqual(CONFIG_ASSETS.map(() => "created"));
  const conf = join(paths.configDir, "launcher.conf");
  expect(await readFile(join(paths.configDir, "prompts", "review.tmpl"), "utf8")).toContain("${comment_count}");

  await writeFile(conf, "user-edited");
  const second = await installConfig(paths, NO_FORCE);
  expect(second.files.map((file) => file.outcome)).toEqual(["skipped", "unchanged", "unchanged", "unchanged"]);
  expect(await readFile(conf, "utf8")).toBe("user-edited");

  const third = await installConfig(paths, FORCE);
  expect(third.files.every((file) => file.outcome === "overwritten")).toBe(true);
  expect(await readFile(conf, "utf8")).toBe(CONFIG_ASSETS[0]?.body ?? "");
});

function sway(extra: Partial<SwayOptions> = {}): SwayOptions {
  return { force: false, print: false, keybind: "$mod+x", issueKeybind: "$mod+y", issueProject: null, env: { HOME: root }, ...extra };
}

test("installSway writes the session switcher binding with the absolute launcher path", async () => {
  const result = await installSway(paths, sway());
  expect(result.outcome).toBe("created");
  expect(result.path).toBe(swayDropinPath(paths));
  const text = await readFile(result.path, "utf8");
  expect(text).toBe(result.snippet);
  expect(text).toBe(
    [
      "# pohunek - generated by `pohunek-work setup sway`. Edit launcher.conf, not this file.",
      `bindsym $mod+x exec exec '${join(paths.launcherBinDir, "pohunek-rofi")}'`,
      "",
    ].join("\n"),
  );
  expect(result.issue_binding).toBe(false);
  expect(result.include_present).toBe(false);
});

test("the issue picker binding is generated only for a configured project", async () => {
  const without = await installSway(paths, sway({ print: true }));
  expect(without.snippet).not.toContain("pohunek-rofi-issue");
  expect(without.snippet).not.toContain("$mod+y");

  const withProject = await installSway(paths, sway({ print: true, issueProject: "ui" }));
  expect(withProject.issue_binding).toBe(true);
  expect(withProject.snippet).toContain(`bindsym $mod+y exec exec '${join(paths.launcherBinDir, "pohunek-rofi-issue")}' 'ui'\n`);
});

test("installSway detects a real include of the drop-in and ignores comments and other directories", async () => {
  await mkdir(paths.swayConfigDir, { recursive: true });
  const config = join(paths.swayConfigDir, "config");
  await writeFile(config, `# include ${paths.swayConfigDir}/config.d/*\nset $dir /etc/sway/config.d\ninclude /etc/sway/config.d/*\n`);
  expect((await installSway(paths, sway())).include_present).toBe(false);
  await writeFile(config, `# my config\ninclude ${paths.swayConfigDir}/config.d/*\n`);
  const again = await installSway(paths, sway());
  expect(again.include_present).toBe(true);
  expect(again.outcome).toBe("unchanged");
});

test("installSway skips a differing drop-in and replaces it with force", async () => {
  await installSway(paths, sway());
  const changed = await installSway(paths, sway({ keybind: "$mod+z" }));
  expect(changed.outcome).toBe("skipped");
  expect(await readFile(changed.path, "utf8")).toContain("$mod+x");
  expect((await installSway(paths, sway({ keybind: "$mod+z", force: true }))).outcome).toBe("overwritten");
});

test("print mode returns the snippet and touches nothing", async () => {
  const result = await installSway(paths, sway({ print: true }));
  expect(result.printed).toBe(true);
  expect(result.outcome).toBeNull();
  expect(result.snippet).toContain("bindsym $mod+x");
  expect(await absent(lstat(paths.swayConfigDir))).toBe(true);
});

test("values that would change what sway parses are refused before anything is written", async () => {
  const refused: Partial<SwayOptions>[] = [
    { keybind: "$mod+x\nexec evil" },
    { keybind: "$mod+x;exec evil" },
    { keybind: "$mod+x,exec evil" },
    { keybind: "" },
    { keybind: "$mod+'x" },
    { issueProject: "ui\nexec evil" },
    { issueProject: "" },
    { issueProject: "ui", issueKeybind: "$mod+y;exec evil" },
  ];
  for (const extra of refused) {
    expect(await failure(installSway(paths, sway(extra)))).toBeInstanceOf(SetupIoError);
  }
  expect(await absent(lstat(paths.swayConfigDir))).toBe(true);
});

test("an unwritable target is a SetupIoError naming the path", async () => {
  const blocker = join(root, "blocker");
  await writeFile(blocker, "file, not a directory");
  const error = await failure(writeManaged(join(blocker, "x"), "body", NO_FORCE));
  expect(error).toBeInstanceOf(SetupIoError);
  expect(error.message).toContain(blocker);
});
