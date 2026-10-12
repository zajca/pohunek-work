// End-to-end scenarios of the project selection of `list` and `watch` against a real pohunekd from the
// pinned core release. Two projects are registered and configured (widgets, gadgets) and a third is only
// configured (sprockets). The GitHub and Linear sources cannot start in this environment, so `list` exits 3
// with `source unavailable` lines; the per-project statuses still show which projects were collected.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runPlugin,
  spawnPlugin,
  startCoreDaemon,
  writePluginConfig,
  type CliResult,
  type CoreDaemon,
  type PluginFixture,
} from "./helpers/core-daemon.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 90_000;
const WATCH_TICK_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;
/** `list` printed rows while at least one source was unavailable. */
const EXIT_PARTIAL = 3;
const EXIT_ERROR = 2;

let daemon: CoreDaemon | null = null;
let fixture: PluginFixture | null = null;

beforeAll(async () => {
  daemon = await startCoreDaemon();
  await daemon.registerProject("widgets", "acme/widgets");
  await daemon.registerProject("gadgets", "acme/gadgets");
  fixture = await writePluginConfig(daemon, [
    { label: "widgets", repo: "acme/widgets" },
    { label: "gadgets", repo: "acme/gadgets" },
    { label: "sprockets", repo: "acme/sprockets" },
  ]);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await daemon?.stop();
});

function requireFixture(): PluginFixture {
  if (fixture === null) throw new Error("the real-daemon fixture did not start");
  return fixture;
}

interface ProjectStatus {
  readonly project: string;
  readonly sources: Readonly<Record<string, string>>;
}

/** Labels of the collected projects; every one must have read the real daemon successfully. */
function collectedProjects(result: CliResult): string[] {
  const envelope = JSON.parse(result.out) as { ok: { projects: readonly ProjectStatus[] } };
  for (const status of envelope.ok.projects) expect(status.sources["pohunek"]).toBe("ok");
  return envelope.ok.projects.map((status) => status.project).sort();
}

function lines(text: string, needle: string): string[] {
  return text.split("\n").filter((line) => line.includes(needle));
}

test("list --project repeated collects exactly the named projects", async () => {
  const result = await runPlugin(requireFixture(), ["list", "--json", "--project", "widgets", "--project", "gadgets"], PROCESS_TIMEOUT_MS);
  expect(result.code).toBe(EXIT_PARTIAL);
  expect(collectedProjects(result)).toEqual(["gadgets", "widgets"]);
  expect(result.err).toContain("source unavailable: widgets github: unauthenticated");
  expect(result.err).toContain("source unavailable: gadgets github: unauthenticated");
  expect(result.err).not.toContain("sprockets");
}, SCENARIO_TIMEOUT_MS);

test("list with one --project collects only that project", async () => {
  const result = await runPlugin(requireFixture(), ["list", "--json", "--project", "widgets"], PROCESS_TIMEOUT_MS);
  expect(result.code).toBe(EXIT_PARTIAL);
  expect(collectedProjects(result)).toEqual(["widgets"]);
  expect(result.err).not.toContain("gadgets");
}, SCENARIO_TIMEOUT_MS);

test("list without --project collects every registered project and warns about the unregistered one", async () => {
  const result = await runPlugin(requireFixture(), ["list", "--json"], PROCESS_TIMEOUT_MS);
  expect(result.code).toBe(EXIT_PARTIAL);
  expect(collectedProjects(result)).toEqual(["gadgets", "widgets"]);
  expect(lines(result.err, "project sprockets: no pohunek project with this label; left out (run doctor)")).toHaveLength(1);
}, SCENARIO_TIMEOUT_MS);

test("list warns once per selected label that is unregistered or has no configuration file, duplicates are harmless", async () => {
  const result = await runPlugin(
    requireFixture(),
    ["list", "--json", "--project", "widgets", "--project", "sprockets", "--project", "widgets", "--project", "nosuch", "--project", "nosuch"],
    PROCESS_TIMEOUT_MS,
  );
  expect(result.code).toBe(EXIT_PARTIAL);
  expect(collectedProjects(result)).toEqual(["widgets"]);
  expect(lines(result.err, "project sprockets: no pohunek project with this label")).toHaveLength(1);
  expect(lines(result.err, "project nosuch: no configuration file for this label")).toHaveLength(1);
  expect(lines(result.err, "source unavailable: widgets github:")).toHaveLength(1);
}, SCENARIO_TIMEOUT_MS);

test("watch refuses every label without a project file among several, before polling", async () => {
  const result = await runPlugin(requireFixture(), ["watch", "--project", "nope", "--project", "widgets", "--project", "other"], PROCESS_TIMEOUT_MS);
  expect(result.code).toBe(EXIT_ERROR);
  expect(result.err).toContain('no project file for labels "nope", "other"');
  expect(result.err).not.toContain("watching every");
}, SCENARIO_TIMEOUT_MS);

interface LogEntry {
  readonly event: string;
  readonly projects?: readonly string[] | null;
  readonly failure?: string;
}

async function readLog(path: string): Promise<LogEntry[]> {
  try {
    // The last element is empty or a line the plugin is still appending.
    const complete = (await readFile(path, "utf8")).split("\n").slice(0, -1);
    return complete.map((line) => JSON.parse(line) as LogEntry);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

test("watch --project repeated polls exactly the named projects and stops on SIGTERM", async () => {
  const plugin = requireFixture();
  const logPath = join(plugin.stateDir, "logs", "watch.log");
  const watch = spawnPlugin(plugin, ["watch", "--project", "widgets", "--project", "gadgets", "--project", "widgets"]);
  let entries: LogEntry[] = [];
  try {
    const deadline = Date.now() + WATCH_TICK_TIMEOUT_MS;
    while (!entries.some((entry) => entry.event === "watch_tick")) {
      if (watch.exitCode !== null) throw new Error(`watch exited early (${String(watch.exitCode)}): ${await new Response(watch.stderr).text()}`);
      if (Date.now() > deadline) throw new Error(`no watch_tick in ${logPath} within ${String(WATCH_TICK_TIMEOUT_MS)} ms`);
      await Bun.sleep(POLL_INTERVAL_MS);
      entries = await readLog(logPath);
    }
  } finally {
    watch.kill("SIGTERM");
  }
  expect(await watch.exited).toBe(0);
  entries = await readLog(logPath);
  const firstTick = entries.findIndex((entry) => entry.event === "watch_tick");
  const failedProjects = new Set(
    entries.slice(0, firstTick).filter((entry) => entry.event === "source_failed").map((entry) => entry.failure?.split(" ")[0]),
  );
  expect([...failedProjects].sort()).toEqual(["gadgets", "widgets"]);
  expect(entries.find((entry) => entry.event === "watch_start")?.projects).toEqual(["widgets", "gadgets"]);
  expect(entries.some((entry) => entry.event === "watch_warning")).toBe(false);
  expect(entries.some((entry) => entry.event === "watch_stop")).toBe(true);
}, SCENARIO_TIMEOUT_MS);
