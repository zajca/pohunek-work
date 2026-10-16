// A relay between the TUI and the real daemon socket. Every request and reply passes through unchanged, except
// for two conditions a scenario needs. The reply to a session's output read is held for a fixed time, for the
// first `holdCount` such replies. After the first hold, `daemon.health` is refused, so a reconnect is refused.
// The TUI reads live output through the SDK, which talks to the socket directly, so only a process on the
// socket can produce these conditions. The session list the TUI polls is read the same way, so a snapshot without
// the session can only be produced here: the relay answers the list with nothing while its flag file exists.
// Two more conditions are produced here. A `notification.list` page that carries a cursor is held while a flag file
// exists, so a scenario can change a record between the pages of one read. The `created_at` of every listed record can
// be pinned to one value: the daemon stamps records with nanoseconds, so only a relay can list records that share a time.
import { appendFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RelayOptions {
  /** The method whose reply is held; `session.output` when absent. */
  readonly holdMethod?: string;
  readonly holdSessionId?: string;
  readonly holdMs: number;
  /** Output reads of the session that pass before the first held one. */
  readonly skipCount: number;
  readonly holdCount: number;
  readonly refuseHealthAfterHold: boolean;
  /**
   * While this file exists, every `session.list` reply that starts while it exists is an empty list. The file is the
   * switch the scenario flips, because the relay runs in its own process.
   */
  readonly emptySessionListFlag?: string;
  /**
   * While this file exists, every `notification.list` page that carries a cursor is held until the file is removed. The
   * relay writes `<flag>.held` when it holds a page, so the scenario can wait for the hold before it changes a record.
   */
  readonly holdCursorFlag?: string;
  /** Every notification listed through the relay carries this `created_at`. */
  readonly notificationCreatedAt?: string;
}

export interface SocketRelay {
  readonly socket: string;
  readonly stop: () => Promise<void>;
}

async function isSocket(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch {
    return false;
  }
}

/** Starts a relay between the TUI at `socket` and the daemon at `target`. */
export async function startSocketRelay(target: string, options: RelayOptions): Promise<SocketRelay> {
  const directory = await mkdtemp(join(tmpdir(), "pw-relay-"));
  const socket = join(directory, "relay.sock");
  const child = Bun.spawn([process.execPath, import.meta.path, socket, target, JSON.stringify(options)], { stdout: "ignore", stderr: "inherit" });
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
  readonly heldCursorPages: Set<string>;
}

/** How often a held cursor page checks whether its flag file is gone. */
const RELEASE_POLL_MS = 20;

/** Runs as the relay process: `socket target options-json`. */
function serve(listenPath: string, targetPath: string, options: RelayOptions): void {
  let holdsLeft = options.holdCount;
  let skipsLeft = options.skipCount;
  let refusingHealth = false;
  const emptyLists = new Set<string>();
  Bun.listen<Link>({
    unix: listenPath,
    socket: {
      open(client) {
        const link: Link = { client, upstream: null, queue: Promise.resolve(), clientPending: "", daemonPending: "", held: new Set(), heldCursorPages: new Set() };
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
      if (request !== null && request["method"] === "daemon.health" && refusingHealth) {
        link.client.write(JSON.stringify({ v: 4, id: request["id"], err: { class: "daemon", code: "relay_refused", msg: "the relay refuses health", recover: "" } }) + "\n");
        continue;
      }
      if (request !== null && request["method"] === "session.list" && options.emptySessionListFlag !== undefined && existsSync(options.emptySessionListFlag)) {
        const id = request["id"];
        if (typeof id === "string" || typeof id === "number") emptyLists.add(String(id));
      }
      if (request !== null && request["method"] === "notification.list" && options.holdCursorFlag !== undefined && existsSync(options.holdCursorFlag)) {
        const id = request["id"];
        const params = request["params"] as { cursor?: unknown } | null;
        if ((typeof id === "string" || typeof id === "number") && typeof params?.cursor === "string") link.heldCursorPages.add(String(id));
      }
      if (request !== null && request["method"] === (options.holdMethod ?? "session.output") && options.holdSessionId !== undefined && (request["params"] as { session_id?: unknown } | null)?.session_id === options.holdSessionId) {
        if (skipsLeft > 0) skipsLeft -= 1;
        else if (holdsLeft > 0) {
          const id = request["id"];
          if (typeof id === "string" || typeof id === "number") link.held.add(String(id));
        }
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
      const out = reply !== null && options.notificationCreatedAt !== undefined && pinCreatedAt(reply, options.notificationCreatedAt) ? JSON.stringify(reply) + "\n" : line;
      if ((typeof id === "string" || typeof id === "number") && link.heldCursorPages.delete(String(id))) {
        // The page is released when the flag is gone; the other replies of the connection keep flowing meanwhile.
        const release = setInterval(() => {
          if (existsSync(options.holdCursorFlag ?? "")) return;
          clearInterval(release);
          try { link.client.write(out); } catch { /* the owner closed the connection meanwhile */ }
        }, RELEASE_POLL_MS);
        appendFileSync(`${options.holdCursorFlag ?? ""}.held`, "held\n");
        continue;
      }
      if ((typeof id === "string" || typeof id === "number") && emptyLists.delete(String(id))) {
        link.client.write(JSON.stringify({ v: reply?.["v"], id, ok: [] }) + "\n");
        // The scenario counts these replies through the flag's sibling file, since the relay is another process.
        appendFileSync(`${options.emptySessionListFlag ?? ""}.served`, "served\n");
        continue;
      }
      if ((typeof id === "string" || typeof id === "number") && link.held.delete(String(id))) {
        holdsLeft -= 1;
        if (options.refuseHealthAfterHold && holdsLeft === 0) refusingHealth = true;
        setTimeout(() => { try { link.client.write(line); } catch { /* the owner closed the connection meanwhile */ } }, options.holdMs);
      } else {
        link.client.write(out);
      }
    }
  }
}

/** Sets `created_at` of every record in a `notification.list` reply and reports whether the reply had records. */
function pinCreatedAt(reply: Record<string, unknown>, createdAt: string): boolean {
  const ok = reply["ok"] as { notifications?: unknown } | null | undefined;
  if (!Array.isArray(ok?.notifications)) return false;
  for (const record of ok.notifications as Record<string, unknown>[]) record["created_at"] = createdAt;
  return true;
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
  const [listenPath, targetPath, optionsJson] = process.argv.slice(2);
  if (listenPath === undefined || targetPath === undefined || optionsJson === undefined) throw new Error("usage: socket-relay <listen> <target> <options-json>");
  serve(listenPath, targetPath, JSON.parse(optionsJson) as RelayOptions);
  await new Promise(() => undefined);
}
