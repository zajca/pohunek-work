// Shared setup of the TUI scenarios: a real daemon, the plugin configuration pointed at it,
// and the TUI process started from the sources with the daemon's environment.
import { join } from "node:path";
import { startCoreDaemon, writePluginConfig, type CoreDaemon, type PluginFixture } from "../../helpers/core-daemon.ts";
import { startCliProxy, type CliProxy, type ProxyRule } from "./cli-proxy.ts";
import { runPty, type PtyResult, type PtyStep } from "./pty.ts";

/** The project every scenario works in; its repository is a local git repository registered with the daemon. */
export const PROJECT = "widgets";
/** Time bound of a scenario that starts a real daemon: its git, daemon and TUI startup run on a loaded host. */
export const REAL_SCENARIO_TIMEOUT_MS = 120_000;
const MAIN = new URL("../../../src/main.ts", import.meta.url).pathname;

export interface TuiScenario {
  readonly daemon: CoreDaemon;
  readonly proxy: CliProxy;
  readonly fixture: PluginFixture;
  run(steps: readonly PtyStep[], options?: { readonly cols?: number; readonly rows?: number; readonly timeoutS?: number }): Promise<PtyResult>;
  stop(): Promise<void>;
}

/**
 * Starts a real daemon and a TUI scenario on it. The TUI calls the pinned CLI through a process
 * proxy (see cli-proxy.ts), which forwards every call unchanged when no rule applies.
 */
export async function startTuiScenario(options: { readonly rules?: readonly ProxyRule[]; readonly extraGlobal?: string; readonly overrides?: Record<string, string | number> } = {}): Promise<TuiScenario> {
  const daemon = await startCoreDaemon();
  let proxy: CliProxy | null = null;
  try {
    await daemon.registerProject(PROJECT, "acme/widgets");
    proxy = await startCliProxy(join(daemon.coreDir, "pohunek"), options.rules ?? []);
    const started = proxy;
    const fixture = await writePluginConfig(daemon, [{ label: PROJECT, repo: "acme/widgets" }], {
      overrides: { "pohunek.bin": started.binary, ...(options.overrides ?? {}) },
      ...(options.extraGlobal === undefined ? {} : { extraGlobal: options.extraGlobal }),
    });
    const env: Record<string, string> = { ...fixture.env, TERM: "xterm-256color", CI: "true" };
    return {
      daemon,
      proxy: started,
      fixture,
      run: (steps, run = {}) => runPty({
        cmd: [Bun.which("bun") ?? "bun", MAIN, "tui"],
        env,
        cols: run.cols ?? 120,
        rows: run.rows ?? 40,
        steps,
        timeoutS: run.timeoutS ?? 25,
      }),
      async stop() {
        await started.close();
        await daemon.stop();
      },
    };
  } catch (error) {
    // A failed setup has no scenario to stop, so the daemon and proxy are released here before the error propagates.
    await proxy?.close();
    await daemon.stop();
    throw error;
  }
}

/** Creates a running shell session through the release CLI and returns its id. */
export async function createShellSession(daemon: CoreDaemon, name: string): Promise<string> {
  const created = await daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", daemon.root, "--name", name, "--json"]);
  const id = (JSON.parse(created.stdout) as { ok?: { id?: unknown } }).ok?.id;
  if (typeof id !== "string") throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  return id;
}
