import { expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config/index.ts";
import { DOCTOR_EXIT_CODES, formatDoctorReport, runDoctor, type DoctorDeps } from "../src/doctor.ts";
import type { KeyringPresence } from "../src/sources/keyring.ts";
import type { PohunekClient } from "../src/sources/pohunek.ts";
import type { GlobalConfig, PluginConfig, ProjectConfig } from "../src/types/config.ts";
import type { PohunekNotification, PohunekProject, PohunekSession, SourceErrorCode, SourceResult } from "../src/types/sources.ts";
import { SpawnError, type Exec, type ExecResult } from "../src/util/exec.ts";

const FAKE_SECRET = "fake-token-not-real";
const GH_STDOUT = "fake-gh-stdout-not-real";

const global = {
  github: { endpoint: "https://gh.example", ghBin: "/bin/gh-fake", timeoutMs: 111, pullRequestPageSize: 1, nestedPageSize: 1, threadCommentPageSize: 1, mergedLookbackDays: 1 },
  linear: {
    endpoint: "https://linear.example",
    secretToolBin: "/bin/st-fake",
    keyringService: "svc-fake",
    keyringKey: "key-fake",
    timeoutMs: 222,
    pageSize: 1,
  },
  pohunek: { bin: "/bin/pohunek-fake", timeoutMs: 333, notificationsPageSize: 1 },
} as unknown as GlobalConfig;

function project(name: string, repo: string, kind: "linear" | "github" = "linear"): ProjectConfig {
  const issueSource = kind === "linear" ? { kind, team: "ABC", pausedStates: [] } : { kind };
  return { name, pohunekLabel: name, repo, issueSource } as unknown as ProjectConfig;
}

const pluginConfig: PluginConfig = {
  configDir: "/cfg",
  global,
  projects: [project("widgets", "acme/widgets")],
};

function registered(label: string, originUrl: string | null): PohunekProject {
  return { id: `id-${label}`, label, originUrl, defaultBaseBranch: null };
}

function projectsOk(data: readonly PohunekProject[]): SourceResult<readonly PohunekProject[]> {
  return { ok: true, source: "pohunek", data, durationMs: 0 };
}

function projectsFail(code: SourceErrorCode): SourceResult<readonly PohunekProject[]> {
  return { ok: false, source: "pohunek", code, message: `msg-${code}`, durationMs: 0 };
}

interface Calls {
  load: number;
  client: number;
  exec: string[][];
  keyring: number;
}

function makeDeps(
  overrides: {
    config?: PluginConfig | Error;
    projects?: SourceResult<readonly PohunekProject[]>;
    sessions?: SourceResult<readonly PohunekSession[]>;
    notifications?: SourceResult<readonly PohunekNotification[]>;
    ghExit?: number | "spawn" | "timeout";
    keyring?: KeyringPresence;
  } = {},
): { deps: DoctorDeps; calls: Calls } {
  const calls: Calls = { load: 0, client: 0, exec: [], keyring: 0 };
  const projects = overrides.projects ?? projectsOk([registered("widgets", "git@github.com:acme/widgets.git")]);
  const ghExit = overrides.ghExit ?? 0;
  const exec: Exec = (argv) => {
    calls.exec.push([...argv]);
    if (ghExit === "spawn") {
      return Promise.reject(new SpawnError(argv[0] ?? "", new Error("boom")));
    }
    const result: ExecResult = {
      exitCode: ghExit === "timeout" ? null : ghExit,
      stdout: GH_STDOUT,
      stderr: GH_STDOUT,
      timedOut: ghExit === "timeout",
    };
    return Promise.resolve(result);
  };
  const deps: DoctorDeps = {
    configDir: "/cfg",
    exec,
    env: {},
    loadConfig: () => {
      calls.load += 1;
      const config = overrides.config ?? pluginConfig;
      return config instanceof Error ? Promise.reject(config) : Promise.resolve(config);
    },
    createPohunekClient: () => {
      calls.client += 1;
      return {
        listProjects: () => Promise.resolve(projects),
        listSessions: () => Promise.resolve(overrides.sessions ?? { ok: true, source: "pohunek", data: [], durationMs: 1 }),
        listNotifications: () =>
          Promise.resolve(overrides.notifications ?? { ok: true, source: "pohunek", data: [], durationMs: 1 }),
      } as unknown as PohunekClient;
    },
    keyringEntryPresent: () => {
      calls.keyring += 1;
      return Promise.resolve(overrides.keyring ?? { present: true });
    },
  };
  return { deps, calls };
}

function codes(report: { checks: readonly { code: string }[] }): string[] {
  return report.checks.map((check) => check.code);
}

test("all checks pass with exit code 0", async () => {
  const { deps } = makeDeps();
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(0);
  expect(report.checks.every((check) => check.ok)).toBe(true);
  expect(codes(report)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
});

test("config error reports file and key, stops later checks, exit 10", async () => {
  const { deps, calls } = makeDeps({ config: new ConfigError("projects/widgets.toml", "repo", "expected a string") });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(10);
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]?.code).toBe("config_invalid");
  expect(report.checks[0]?.message).toContain("projects/widgets.toml");
  expect(report.checks[0]?.message).toContain("repo");
  expect(calls.client).toBe(0);
  expect(calls.exec).toHaveLength(0);
  expect(calls.keyring).toBe(0);
});

test("non-config load errors propagate", async () => {
  const { deps } = makeDeps({ config: new TypeError("unexpected") });
  const outcome = await runDoctor(deps).then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(TypeError);
});

test("incomplete origin environment names both variables, exit 12", async () => {
  const { deps } = makeDeps({ projects: projectsFail("origin_environment") });
  const report = await runDoctor(deps);
  const check = report.checks.find((c) => c.code === "pohunek_origin_environment");
  expect(report.exitCode).toBe(12);
  expect(check?.message).toContain("POHUNEK_SESSION_ID");
  expect(check?.message).toContain("POHUNEK_DAEMON_ID");
  expect(check?.message).toContain("set both or unset both");
});

test("protocol mismatch maps to exit 19", async () => {
  const { deps } = makeDeps({ projects: projectsFail("protocol_mismatch") });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(19);
  expect(codes(report)).toContain("pohunek_protocol");
});

test.each<SourceErrorCode>(["unavailable", "timeout", "invalid_response"])("pohunek failure %s maps to unreachable, exit 11", async (code) => {
  const { deps } = makeDeps({ projects: projectsFail(code) });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(11);
  expect(report.checks.find((c) => c.code === "pohunek_unreachable")?.message).toContain(code);
  expect(report.checks.some((c) => c.name.startsWith("project "))).toBe(false);
});

test("missing project suggests pohunek project list, exit 13", async () => {
  const { deps } = makeDeps({ projects: projectsOk([registered("other", "git@github.com:acme/other.git")]) });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(13);
  const check = report.checks.find((c) => c.code === "project_missing");
  expect(check?.message).toContain("pohunek project list");
  expect(check?.message).toContain("widgets");
});

test("renamed project is a label mismatch naming both labels, exit 14", async () => {
  const { deps } = makeDeps({ projects: projectsOk([registered("widgets-renamed", "git@github.com:acme/widgets.git")]) });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(14);
  const check = report.checks.find((c) => c.code === "project_label_mismatch");
  expect(check?.message).toContain('"widgets"');
  expect(check?.message).toContain('"widgets-renamed"');
});

test("two candidate projects with the same origin stay project_missing", async () => {
  const { deps } = makeDeps({
    projects: projectsOk([
      registered("a", "git@github.com:acme/widgets.git"),
      registered("b", "https://github.com/acme/widgets"),
    ]),
  });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(13);
});

test("origin mismatch, exit 15", async () => {
  const { deps } = makeDeps({ projects: projectsOk([registered("widgets", "git@github.com:acme/gadgets.git")]) });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(15);
  const check = report.checks.find((c) => c.code === "project_origin_mismatch");
  expect(check?.message).toContain("acme/gadgets");
  expect(check?.message).toContain("acme/widgets");
});

test("non-GitHub or missing origin is an origin mismatch", async () => {
  for (const origin of [null, "git@gitlab.example:acme/widgets.git"]) {
    const { deps } = makeDeps({ projects: projectsOk([registered("widgets", origin)]) });
    expect((await runDoctor(deps)).exitCode).toBe(15);
  }
});

test.each(["git@github.com:acme/widgets.git", "https://github.com/ACME/Widgets.git", "ssh://git@github.com/acme/widgets"])(
  "origin form %s matches case-insensitively",
  async (origin) => {
    const { deps } = makeDeps({ projects: projectsOk([registered("widgets", origin)]) });
    expect((await runDoctor(deps)).exitCode).toBe(0);
  },
);

test("gh auth failure uses auth status argv and never leaks output, exit 16", async () => {
  const { deps, calls } = makeDeps({ ghExit: 1 });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(16);
  expect(calls.exec).toEqual([["/bin/gh-fake", "auth", "status"]]);
  expect(JSON.stringify(report)).not.toContain(GH_STDOUT);
});

test("gh spawn error and timeout map to github_unauthenticated", async () => {
  for (const ghExit of ["spawn", "timeout"] as const) {
    const { deps } = makeDeps({ ghExit });
    const report = await runDoctor(deps);
    expect(report.exitCode).toBe(16);
    expect(JSON.stringify(report)).not.toContain(GH_STDOUT);
  }
});

test("missing keyring entry names service and key, exit 17", async () => {
  const { deps } = makeDeps({ keyring: { present: false, kind: "not_found" } });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(17);
  const check = report.checks.find((c) => c.code === "linear_keyring_missing");
  expect(check?.message).toContain("svc-fake");
  expect(check?.message).toContain("key-fake");
});

test.each(["locked", "unavailable"] as const)("keyring %s maps to exit 18", async (kind) => {
  const { deps } = makeDeps({ keyring: { present: false, kind } });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(18);
  expect(codes(report)).toContain("linear_keyring_unavailable");
});

test("keyring secret never appears in the report", async () => {
  const { deps } = makeDeps();
  const leaky = { present: true, secret: FAKE_SECRET } as KeyringPresence;
  const report = await runDoctor({ ...deps, keyringEntryPresent: () => Promise.resolve(leaky) });
  expect(JSON.stringify(report)).not.toContain(FAKE_SECRET);
  expect(formatDoctorReport(report)).not.toContain(FAKE_SECRET);
});

test("failures are collected and the first failing check decides the exit code", async () => {
  const { deps } = makeDeps({
    projects: projectsOk([registered("widgets", "git@github.com:acme/gadgets.git")]),
    ghExit: 1,
    keyring: { present: false, kind: "not_found" },
  });
  const report = await runDoctor(deps);
  expect(codes(report)).toEqual(["ok", "ok", "project_origin_mismatch", "github_unauthenticated", "linear_keyring_missing"]);
  expect(report.exitCode).toBe(15);
});

test("formatDoctorReport prints one line per check with status and code", async () => {
  const { deps } = makeDeps({ ghExit: 1 });
  const lines = formatDoctorReport(await runDoctor(deps)).split("\n");
  expect(lines).toHaveLength(5);
  expect(lines[0]?.startsWith("ok")).toBe(true);
  expect(lines[3]?.startsWith("FAIL github_unauthenticated")).toBe(true);
});

test("exit codes are distinct and non-zero", () => {
  const values = Object.values(DOCTOR_EXIT_CODES);
  expect(new Set(values).size).toBe(values.length);
  expect(values.every((value) => value > 0)).toBe(true);
  expect(DOCTOR_EXIT_CODES).toEqual({
    config_invalid: 10,
    pohunek_unreachable: 11,
    pohunek_origin_environment: 12,
    project_missing: 13,
    project_label_mismatch: 14,
    project_origin_mismatch: 15,
    github_unauthenticated: 16,
    linear_keyring_missing: 17,
    linear_keyring_unavailable: 18,
    pohunek_protocol: 19,
  });
});

test("an unreadable notification list is a pohunek failure even when project list works", async () => {
  const { deps } = makeDeps({
    notifications: { ok: false, source: "pohunek", code: "unavailable", message: "framing", durationMs: 1 },
  });
  const report = await runDoctor(deps);
  expect(report.exitCode).toBe(DOCTOR_EXIT_CODES.pohunek_unreachable);
  expect(report.checks.find((c) => c.name === "pohunek")?.message).toContain("unavailable");
});

test("a config without the [tui] table fails the config check naming the table", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pohunek-work-doctor-"));
  try {
    await cp(join(import.meta.dir, "fixtures", "config"), dir, { recursive: true });
    const file = join(dir, "config.toml");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.slice(0, text.indexOf("[tui]")));
    const { deps, calls } = makeDeps();
    const report = await runDoctor({ ...deps, configDir: dir, loadConfig });
    expect(report.exitCode).toBe(DOCTOR_EXIT_CODES.config_invalid);
    expect(report.checks[0]?.message).toContain("config.toml: tui is required");
    expect(calls.client).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const LAUNCHER_NAMES = ["bin:rofi", "bin:swaymsg", "bin:python3", "terminal", "launcher_scripts", "sway_include"];

test("without a launcher probe no launcher check runs", async () => {
  const { deps } = makeDeps();
  const report = await runDoctor(deps);
  expect(report.checks.map((check) => check.name)).not.toContain("bin:rofi");
});

test("launcher findings are advisory: every one warns, the exit code stays 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pohunek-work-doctor-launcher-"));
  try {
    const { deps } = makeDeps();
    const report = await runDoctor({ ...deps, launcher: { env: { PATH: dir, HOME: dir }, platform: "linux" } });
    expect(report.exitCode).toBe(0);
    const launcher = report.checks.slice(5);
    expect(launcher.map((check) => check.name)).toEqual(LAUNCHER_NAMES);
    expect(launcher.every((check) => check.ok && check.code === "warn")).toBe(true);
    const lines = formatDoctorReport(report).split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[5]).toBe("warn warn bin:rofi: 'rofi' not found on PATH");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a satisfied launcher check passes with code ok", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pohunek-work-doctor-launcher-"));
  try {
    const { deps } = makeDeps();
    const foot = join(dir, "foot");
    await writeFile(foot, "#!/bin/sh\n");
    await chmod(foot, 0o755);
    const report = await runDoctor({ ...deps, launcher: { env: { PATH: dir, HOME: dir, TERMINAL: "foot" }, platform: "linux" } });
    expect(report.checks.find((check) => check.name === "terminal")).toEqual({
      name: "terminal",
      ok: true,
      code: "ok",
      message: `TERMINAL 'foot' resolves to ${foot}`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("launcher checks still run when the config is invalid, and the config failure keeps the exit code", async () => {
  const { deps } = makeDeps({ config: new ConfigError("config.toml", "", "file not found") });
  const report = await runDoctor({ ...deps, launcher: { env: { PATH: "/nonexistent", HOME: "/nonexistent" }, platform: "linux" } });
  expect(report.exitCode).toBe(DOCTOR_EXIT_CODES.config_invalid);
  expect(report.checks.map((check) => check.name)).toEqual(["config", ...LAUNCHER_NAMES]);
});

test("a real failure after advisory findings still decides the exit code", async () => {
  const { deps } = makeDeps({ ghExit: 1 });
  const report = await runDoctor({ ...deps, launcher: { env: { PATH: "/nonexistent", HOME: "/nonexistent" }, platform: "linux" } });
  expect(report.exitCode).toBe(DOCTOR_EXIT_CODES.github_unauthenticated);
});

const githubOnlyConfig: PluginConfig = {
  configDir: "/cfg",
  global: { ...global, linear: null },
  projects: [project("widgets", "acme/widgets", "github")],
};

test("a configuration without a Linear project skips the keyring check and says so", async () => {
  const { deps, calls } = makeDeps({ config: githubOnlyConfig, keyring: { present: false, kind: "not_found" } });
  const report = await runDoctor(deps);
  expect(calls.keyring).toBe(0);
  expect(report.exitCode).toBe(0);
  const keyring = report.checks.find((c) => c.name === "linear keyring");
  expect(keyring?.ok).toBe(true);
  expect(keyring?.message).toContain("not needed");
});

test("every project line names its issue source", async () => {
  const mixed: PluginConfig = {
    ...pluginConfig,
    projects: [project("widgets", "acme/widgets", "linear"), project("gadgets", "acme/gadgets", "github")],
  };
  const { deps, calls } = makeDeps({
    config: mixed,
    projects: projectsOk([
      registered("widgets", "git@github.com:acme/widgets.git"),
      registered("gadgets", "git@github.com:acme/other.git"),
    ]),
  });
  const report = await runDoctor(deps);
  expect(report.checks.find((c) => c.name === "project widgets")?.message).toContain("[issue source: linear]");
  const gadgets = report.checks.find((c) => c.name === "project gadgets");
  expect(gadgets?.code).toBe("project_origin_mismatch");
  expect(gadgets?.message).toContain("[issue source: github]");
  expect(calls.keyring).toBe(1);
});
