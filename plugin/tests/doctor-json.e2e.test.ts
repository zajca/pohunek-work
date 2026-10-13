// End-to-end scenarios of `pohunek-work doctor --json` against a real pohunekd from the pinned core
// release. widgets and gadgets are registered and configured with Linear issues, `gh` and `secret-tool`
// are script stand-ins that print a token and a keyring secret, and launcher.conf names a terminal that
// does not resolve, so every report carries an advisory `warn`. Each scenario runs doctor with and
// without --json and checks that both reports agree and that neither repeats the token or the secret.
import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { toAscii } from "../src/output/sanitize.ts";
import {
  DAEMON_STOP_HOOK_TIMEOUT_MS,
  runPlugin,
  startCoreDaemon,
  writePluginConfig,
  type CliResult,
  type CoreDaemon,
  type PluginConfigOptions,
  type PluginFixture,
} from "./helpers/core-daemon.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 120_000;
/** Envelope version of `doctor --json`. */
const DOCTOR_CONTRACT = 1;
/** `doctor` exit code of an invalid configuration. */
const EXIT_CONFIG_INVALID = 10;
/** `doctor` exit code of a failed `gh auth status`. */
const EXIT_GITHUB_UNAUTHENTICATED = 16;
/** Printed by the `gh` stand-in on stdout and stderr; doctor never repeats it. */
const GH_TOKEN = "gho_doctorJsonStandInToken0123456789abcdef";
/** Printed by the `secret-tool` stand-in as the keyring value; doctor never repeats it. */
const KEYRING_SECRET = "lin_api_doctorJsonStandInSecret0123456789abcdef";
/** `terminal=` of launcher.conf: resolves to no executable, so the terminal check is an advisory warning. */
const UNRESOLVED_TERMINAL = "no-such-terminal";
/**
 * A `terminal=` value carrying an OSC 8 hyperlink (ESC, BEL), a right-to-left override and a Czech letter:
 * the text report shows it as one strict-ASCII line, the JSON report keeps it escaped.
 */
const HOSTILE_TERMINAL = "evil\u001b]8;;https://attacker.example\u0007link\u202eťerm";
/** `HOSTILE_TERMINAL` as the text report prints it: NFKD without combining marks, every other non-ASCII character `?`. */
const HOSTILE_TERMINAL_ASCII = "evil?]8;;https://attacker.example?link?term";

interface DoctorJsonCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
}

interface DoctorDocument {
  readonly cli_version: string;
  readonly protocol: { readonly minimum: number; readonly maximum: number };
  readonly ok: { readonly passed: boolean; readonly exit_code: number; readonly checks: readonly DoctorJsonCheck[] };
}

interface Setup {
  readonly daemon: CoreDaemon;
  readonly ghOk: string;
  readonly ghFailing: string;
  readonly secretTool: string;
  readonly workdir: string;
}

let daemon: CoreDaemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

/** A `/bin/sh` script below the daemon root; the plugin's PATH holds no `sh` utilities, so it uses builtins only. */
async function script(core: CoreDaemon, name: string, body: string): Promise<string> {
  const path = join(core.root, "bin", name);
  await writeFile(path, `#!/bin/sh\n${body}`, { mode: 0o755 });
  return path;
}

/** `gh auth status` that prints the token on both streams and exits with `exitCode`; every other call fails. */
function ghStandIn(exitCode: number): string {
  return `if [ "$1" = auth ] && [ "$2" = status ]; then\n  echo "Token: ${GH_TOKEN}"\n  echo "Token: ${GH_TOKEN}" >&2\n  exit ${String(exitCode)}\nfi\nexit 64\n`;
}

async function setUp(terminal: string = UNRESOLVED_TERMINAL): Promise<Setup> {
  const started = await startCoreDaemon();
  daemon = started;
  await started.registerProject("widgets", "acme/widgets");
  await started.registerProject("gadgets", "acme/gadgets");
  const ghOk = await script(started, "gh-ok", ghStandIn(0));
  const ghFailing = await script(started, "gh-failing", ghStandIn(1));
  const secretTool = await script(started, "secret-tool", `if [ "$1" = lookup ]; then\n  echo "${KEYRING_SECRET}"\n  exit 0\nfi\nexit 64\n`);
  const workdir = join(started.root, "manager");
  await mkdir(workdir, { mode: 0o700 });
  // The launcher reads launcher.conf from the pohunek directory below XDG_CONFIG_HOME.
  const launcherDir = join(started.root, "config", "pohunek");
  await mkdir(launcherDir, { recursive: true, mode: 0o700 });
  await writeFile(join(launcherDir, "launcher.conf"), `terminal=${terminal}\n`);
  return { daemon: started, ghOk, ghFailing, secretTool, workdir };
}

function configure(setup: Setup, name: string, ghBin: string, extraGlobal: string): Promise<PluginFixture> {
  const options: PluginConfigOptions = {
    name,
    extraGlobal,
    overrides: { "github.gh_bin": ghBin, "linear.secret_tool_bin": setup.secretTool },
  };
  return writePluginConfig(setup.daemon, [{ label: "widgets", repo: "acme/widgets" }, { label: "gadgets", repo: "acme/gadgets" }], options);
}

function managerTable(workdir: string): string {
  return `\n[manager]\nprofile = "shell"\nworkdir = ${JSON.stringify(workdir)}\n`;
}

/** One line of the text report, in its documented format; the name and the message are printed in strict ASCII. */
function textLine(check: DoctorJsonCheck): string {
  const status = check.ok ? (check.code === "warn" ? "warn" : "ok  ") : "FAIL";
  return `${status} ${check.code} ${toAscii(check.name)}: ${toAscii(check.message)}`;
}

function checkNamed(document: DoctorDocument, name: string): DoctorJsonCheck {
  const found = document.ok.checks.find((check) => check.name === name);
  if (found === undefined) throw new Error(`no check named ${name}: ${JSON.stringify(document.ok.checks)}`);
  return found;
}

/**
 * Runs doctor as text and as JSON, and checks the contract both share: stdout of `--json` is exactly
 * one envelope, both exit with the report's exit code, the text report has one line per JSON check in
 * the same order, and neither output repeats the stand-ins' token or secret.
 */
async function doctor(fixture: PluginFixture): Promise<DoctorDocument> {
  const text: CliResult = await runPlugin(fixture, ["doctor"], PROCESS_TIMEOUT_MS);
  const json: CliResult = await runPlugin(fixture, ["doctor", "--json"], PROCESS_TIMEOUT_MS);
  const document = JSON.parse(json.out) as DoctorDocument;
  expect(json.err).toBe("");
  expect(Object.keys(document).sort()).toEqual(["cli_version", "ok", "protocol"]);
  expect(document.cli_version).toBe(pkg.version);
  expect(document.protocol).toEqual({ minimum: DOCTOR_CONTRACT, maximum: DOCTOR_CONTRACT });
  expect(Object.keys(document.ok).sort()).toEqual(["checks", "exit_code", "passed"]);
  for (const check of document.ok.checks) expect(Object.keys(check).sort()).toEqual(["code", "message", "name", "ok"]);
  expect(document.ok.passed).toBe(document.ok.checks.every((check) => check.ok));
  expect(json.code).toBe(document.ok.exit_code);
  expect(text.code).toBe(document.ok.exit_code);
  expect(text.out).toBe(`${document.ok.checks.map(textLine).join("\n")}\n`);
  for (const result of [text, json]) {
    for (const secret of [GH_TOKEN, KEYRING_SECRET]) {
      expect(result.out).not.toContain(secret);
      expect(result.err).not.toContain(secret);
    }
  }
  return document;
}

function expectTerminalWarning(document: DoctorDocument): void {
  const terminal = checkNamed(document, "terminal");
  expect(terminal).toMatchObject({ ok: true, code: "warn" });
  expect(terminal.message).toContain(UNRESOLVED_TERMINAL);
}

test("a passing report is one JSON document with passed true, exit 0 and every check, warnings included", async () => {
  const setup = await setUp();
  const fixture = await configure(setup, "passing", setup.ghOk, managerTable(setup.workdir));
  const document = await doctor(fixture);
  expect(document.ok.passed).toBe(true);
  expect(document.ok.exit_code).toBe(0);
  for (const name of ["config", "manager workdir", "pohunek", "project widgets", "project gadgets", "manager workdir placement", "github auth", "linear keyring"]) {
    expect(checkNamed(document, name)).toMatchObject({ ok: true, code: "ok" });
  }
  expect(checkNamed(document, "config").message).toBe("2 project file(s) loaded");
  expect(checkNamed(document, "pohunek").message).toBe("reachable, 2 project(s) registered");
  expect(checkNamed(document, "github auth").message).toBe("gh is authenticated");
  expectTerminalWarning(document);
}, SCENARIO_TIMEOUT_MS);

test("an invalid configuration is one JSON document with passed false and exit 10, next to the launcher warnings", async () => {
  const setup = await setUp();
  const fixture = await configure(setup, "invalid", setup.ghOk, '\n[manager]\nprofile = "shell"\n');
  const document = await doctor(fixture);
  expect(document.ok.passed).toBe(false);
  expect(document.ok.exit_code).toBe(EXIT_CONFIG_INVALID);
  const [first] = document.ok.checks;
  expect(first).toMatchObject({ name: "config", ok: false, code: "config_invalid" });
  expect(first?.message).toContain("[manager] workdir is required");
  expect(document.ok.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["config"]);
  expectTerminalWarning(document);
}, SCENARIO_TIMEOUT_MS);

test("a failed gh auth status exits 16 and the token gh printed appears in neither report", async () => {
  const setup = await setUp();
  const fixture = await configure(setup, "unauthenticated", setup.ghFailing, managerTable(setup.workdir));
  const document = await doctor(fixture);
  expect(document.ok.passed).toBe(false);
  expect(document.ok.exit_code).toBe(EXIT_GITHUB_UNAUTHENTICATED);
  expect(document.ok.checks.filter((check) => !check.ok)).toEqual([
    { name: "github auth", ok: false, code: "github_unauthenticated", message: `${setup.ghFailing} auth status exited with code 1; run \`gh auth login\`` },
  ]);
  expect(checkNamed(document, "linear keyring")).toMatchObject({ ok: true, code: "ok" });
  expectTerminalWarning(document);
}, SCENARIO_TIMEOUT_MS);

test("a hostile launcher.conf value reaches the text report as one strict-ASCII line and the JSON report escaped", async () => {
  const setup = await setUp(HOSTILE_TERMINAL);
  const fixture = await configure(setup, "hostile", setup.ghOk, managerTable(setup.workdir));
  const text = await runPlugin(fixture, ["doctor"], PROCESS_TIMEOUT_MS);
  const line = text.out.split("\n").find((candidate) => candidate.includes(" terminal: "));
  expect(line).toContain(HOSTILE_TERMINAL_ASCII);
  expect(text.out).not.toMatch(/[^\x20-\x7e\n]/);
  const document = await doctor(fixture);
  expect(checkNamed(document, "terminal")).toMatchObject({ ok: true, code: "warn" });
  expect(checkNamed(document, "terminal").message).toContain(HOSTILE_TERMINAL);
}, SCENARIO_TIMEOUT_MS);
