// A daemon stand-in at the socket boundary for scenarios whose sessions or notifications the real
// release cannot produce (a resumable agent with a native conversation, notifications from agent
// reports, a lost runtime with resume). The TUI reads sessions and notifications through the SDK
// from this socket. The stand-in answers each read by running the scenario's own CLI relay with the
// same arguments the CLI would take, so the data the scenario defines is what the TUI shows. Every
// other method is refused, which keeps mutations on the real CLI path.
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SdkStandIn {
  readonly socket: string;
  readonly stop: () => Promise<void>;
}

const SERVER = `
const [socketPath, relay] = process.argv.slice(2);
const buffers = new Map();
async function runRelay(args) {
  const child = Bun.spawn([relay, ...args], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  const envelope = JSON.parse(text);
  if (!("ok" in envelope)) throw new Error("relay returned an error envelope");
  return envelope.ok;
}
async function answer(socket, request) {
  const reply = (body) => socket.write(JSON.stringify({ v: 4, id: request.id, ...body }) + "\\n");
  try {
    if (request.method === "daemon.health") return reply({ ok: { status: "ok", daemon_version: "0.34.2", protocol_version: 4 } });
    if (request.method === "session.list") return reply({ ok: await runRelay(["--host", "local", "session", "list", "--json"]) });
    if (request.method === "notification.list") {
      const status = request.params && request.params.status;
      const page = await runRelay(["--host", "local", "notifications", "list", "--limit", "100", ...(status ? ["--status", status] : []), "--json"]);
      return reply({ ok: { notifications: page.notifications, next_cursor: null } });
    }
    if (request.method === "subscribe") return reply({ ok: null });
    return reply({ err: { class: "unsupported", code: "stand_in_read_only", msg: "the stand-in serves the scenario reads only: " + request.method, recover: "use the CLI" } });
  } catch (error) {
    return reply({ err: { class: "unavailable", code: "stand_in_relay_failed", msg: String(error), recover: "fix the scenario relay" } });
  }
}
Bun.listen({
  unix: socketPath,
  socket: {
    open(socket) { buffers.set(socket, ""); },
    data(socket, chunk) {
      let text = buffers.get(socket) + chunk.toString();
      let newline;
      while ((newline = text.indexOf("\\n")) !== -1) {
        const line = text.slice(0, newline);
        text = text.slice(newline + 1);
        if (line.trim() !== "") void answer(socket, JSON.parse(line));
      }
      buffers.set(socket, text);
    },
    close(socket) { buffers.delete(socket); },
    error() {},
  },
});
`;

async function isSocket(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Starts the stand-in on a fresh socket; `relay` is the scenario's CLI that serves the reads. */
export async function startSdkStandIn(relay: string): Promise<SdkStandIn> {
  const directory = await mkdtemp(join(tmpdir(), "pw-standin-"));
  const socket = join(directory, "daemon.sock");
  const script = join(directory, "stand-in.ts");
  await writeFile(script, SERVER);
  await chmod(script, 0o600);
  const child = Bun.spawn([process.execPath, script, socket, relay], { stdout: "ignore", stderr: "inherit" });
  const deadline = Date.now() + 10_000;
  while (!(await isSocket(socket))) {
    if (child.exitCode !== null) throw new Error("the SDK stand-in exited before it listened");
    if (Date.now() > deadline) throw new Error("the SDK stand-in did not listen within 10 s");
    await Bun.sleep(20);
  }
  return {
    socket,
    stop: async () => {
      child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * A stand-in whose reads are empty: the scenario has no sessions or notifications, and the TUI
 * still needs a daemon socket to read them from.
 */
export async function startEmptySdkStandIn(): Promise<SdkStandIn> {
  const directory = await mkdtemp(join(tmpdir(), "pw-empty-relay-"));
  const relay = join(directory, "relay");
  await writeFile(relay, `#!${process.execPath}
const args = process.argv.slice(2);
const ok = args.includes("notifications") ? { notifications: [], next_cursor: null } : [];
process.stdout.write(JSON.stringify({ cli_version: "0.34.2", protocol: { minimum: 4, maximum: 4 }, ok }) + "\\n");
`);
  await chmod(relay, 0o700);
  const stand = await startSdkStandIn(relay);
  return {
    socket: stand.socket,
    stop: async () => {
      await stand.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
