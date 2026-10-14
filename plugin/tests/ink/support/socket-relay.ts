// A relay between the TUI and the real daemon socket. Every request and reply passes through unchanged,
// except that the reply to one session's output read is held for a fixed time. The TUI reads live output
// through the SDK, which talks to the socket directly, so only a process on the socket can delay that reply.
// The scenario that uses it needs the reply of one session to arrive after the owner has moved on.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function isSocket(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch {
    return false;
  }
}

export interface SocketRelay {
  readonly socket: string;
  readonly stop: () => Promise<void>;
}

/** Starts a relay that holds the reply to `session.output` for `holdSessionId` by `holdMs`; the daemon serves the rest. */
export async function startSocketRelay(target: string, holdSessionId: string, holdMs: number): Promise<SocketRelay> {
  const directory = await mkdtemp(join(tmpdir(), "pw-relay-"));
  const socket = join(directory, "relay.sock");
  const child = Bun.spawn([process.execPath, import.meta.path, socket, target, holdSessionId, String(holdMs)], { stdout: "ignore", stderr: "inherit" });
  const deadline = Date.now() + 10_000;
  while (!(await isSocket(socket))) {
    if (child.exitCode !== null) throw new Error("the socket relay exited before it listened");
    if (Date.now() > deadline) throw new Error("the socket relay did not listen within 10 s");
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

interface Link {
  readonly client: { write(data: string): number; end(): void };
  upstream: { write(data: string): number; end(): void } | null;
  queue: Promise<void>;
  clientPending: string;
  daemonPending: string;
  readonly held: Set<string>;
}

/** Runs as the relay process: `socket target holdSessionId holdMs`. */
function serve(listenPath: string, targetPath: string, holdSessionId: string, holdMs: number): void {
  Bun.listen<Link>({
    unix: listenPath,
    socket: {
      open(client) {
        const link: Link = { client, upstream: null, queue: Promise.resolve(), clientPending: "", daemonPending: "", held: new Set() };
        client.data = link;
        link.queue = Bun.connect<Link>({
          unix: targetPath,
          socket: {
            open(upstream) { upstream.data = link; link.upstream = upstream; },
            data(_upstream, chunk) { link.queue = link.queue.then(() => { fromDaemon(link, chunk.toString()); }); },
            close() { client.end(); },
            error() { client.end(); },
          },
        }).then(() => undefined);
      },
      data(client, chunk) {
        const link = client.data;
        link.queue = link.queue.then(() => { fromClient(link, chunk.toString()); });
      },
      close(client) {
        client.data.upstream?.end();
      },
      error(client) { client.end(); },
    },
  });

  function fromClient(link: Link, text: string): void {
    link.clientPending += text;
    for (;;) {
      const newline = link.clientPending.indexOf("\n");
      if (newline < 0) return;
      const line = link.clientPending.slice(0, newline + 1);
      link.clientPending = link.clientPending.slice(newline + 1);
      const request = parse(line);
      if (request !== null && request["method"] === "session.output" && (request["params"] as { session_id?: unknown } | null)?.session_id === holdSessionId) {
        link.held.add(String(request["id"]));
      }
      link.upstream?.write(line);
    }
  }

  function fromDaemon(link: Link, text: string): void {
    link.daemonPending += text;
    for (;;) {
      const newline = link.daemonPending.indexOf("\n");
      if (newline < 0) return;
      const line = link.daemonPending.slice(0, newline + 1);
      link.daemonPending = link.daemonPending.slice(newline + 1);
      const reply = parse(line);
      const id = reply?.["id"];
      if ((typeof id === "string" || typeof id === "number") && link.held.delete(String(id))) {
        setTimeout(() => { try { link.client.write(line); } catch { /* the owner closed the connection meanwhile */ } }, holdMs);
      } else {
        link.client.write(line);
      }
    }
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const [listenPath, targetPath, holdSessionId, holdMs] = process.argv.slice(2);
  if (listenPath === undefined || targetPath === undefined || holdSessionId === undefined || holdMs === undefined) throw new Error("usage: socket-relay <listen> <target> <session> <holdMs>");
  serve(listenPath, targetPath, holdSessionId, Number(holdMs));
  await new Promise(() => undefined);
}
