// A process between the plugin and the pinned pohunek CLI. Every call is forwarded to the real
// release binary and its argv is recorded. A scenario rule can delay a call, refuse it, rewrite
// the protocol range of its envelope, add a host to `host list`, or alias a host route to the
// local daemon. Sessions, screens and actions are always produced by the real core; a rule only
// creates the condition the scenario needs, and the test says which condition and why.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProxyRule {
  /** Every token must appear in the call's argv for the rule to apply. */
  readonly match: readonly string[];
  readonly delayMs?: number;
  /** Refuses the call with this status instead of forwarding it. */
  readonly failWith?: number;
  /** Runs this argv in place of the call, with the terminal inherited (a stand-in for an interactive child). */
  readonly replaceWith?: readonly string[];
  /** Replaces the envelope's protocol range; the call still runs in the real core. */
  readonly protocolRange?: { readonly minimum: number; readonly maximum: number };
  /**
   * Adds these items to the `ok` array of the envelope (for `host list`). A call the core refuses
   * because netbird is not installed (the fixture has no overlay) gets an empty list first.
   */
  readonly appendOk?: readonly Record<string, unknown>[];
  /** Rewrites every argument that starts with `from` to `to`, for host routes of appended hosts. */
  readonly aliasPrefix?: { readonly from: string; readonly to: string };
}

export interface CliProxy {
  readonly binary: string;
  /** Replaces the rules; the next call uses them. */
  setRules(rules: readonly ProxyRule[]): Promise<void>;
  /** Argv of every call, in order. */
  calls(): Promise<string[][]>;
  close(): Promise<void>;
}

export async function startCliProxy(realBinary: string, rules: readonly ProxyRule[]): Promise<CliProxy> {
  const directory = await mkdtemp(join(tmpdir(), "pw-proxy-"));
  const rulesPath = join(directory, "rules.json");
  const tracePath = join(directory, "calls.jsonl");
  const binary = join(directory, "pohunek");
  await writeFile(rulesPath, JSON.stringify(rules));
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const recorded = process.argv.slice(2);
appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(recorded) + "\\n");
const rules = JSON.parse(readFileSync(${JSON.stringify(rulesPath)}, "utf8"));
const matched = rules.filter((rule) => rule.match.every((token) => recorded.includes(token)));
for (const rule of matched) if (rule.delayMs !== undefined) await Bun.sleep(rule.delayMs);
const replaced = matched.find((rule) => rule.replaceWith !== undefined);
if (replaced !== undefined) { const stand = Bun.spawn(replaced.replaceWith, { stdio: ["inherit", "inherit", "inherit"] }); process.exit(await stand.exited); }
const refused = matched.find((rule) => rule.failWith !== undefined);
if (refused !== undefined) { process.stderr.write("proxy: call refused by the scenario\\n"); process.exit(refused.failWith); }
const args = recorded.map((arg) => {
  for (const rule of matched) if (rule.aliasPrefix !== undefined && arg.startsWith(rule.aliasPrefix.from)) return rule.aliasPrefix.to;
  return arg;
});
const edit = matched.some((rule) => rule.protocolRange !== undefined || rule.appendOk !== undefined);
const child = Bun.spawn([${JSON.stringify(realBinary)}, ...args], { stdio: edit ? ["inherit", "pipe", "inherit"] : ["inherit", "inherit", "inherit"] });
// A stop sent to the proxy reaches the real CLI too; the attach it runs must not outlive the proxy.
process.on("SIGTERM", () => { child.kill("SIGTERM"); });
if (!edit) process.exit(await child.exited);
const envelope = JSON.parse(await new Response(child.stdout).text());
for (const rule of matched) {
  if (rule.protocolRange !== undefined) envelope.protocol = rule.protocolRange;
  if (rule.appendOk !== undefined) { delete envelope.err; envelope.ok = [...(envelope.ok ?? []), ...rule.appendOk]; }
}
process.stdout.write(JSON.stringify(envelope) + "\\n");
const status = await child.exited;
// A host list the core refused (no netbird) is reported as success once its hosts are added.
process.exit(matched.some((rule) => rule.appendOk !== undefined) ? 0 : status);
`);
  await chmod(binary, 0o755);
  return {
    binary,
    async setRules(next) {
      await writeFile(rulesPath, JSON.stringify(next));
    },
    async calls() {
      try {
        return (await readFile(tracePath, "utf8")).trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as string[]);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    },
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
