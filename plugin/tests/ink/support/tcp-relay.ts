// A TCP listener on 127.0.0.1 that forwards every connection to the daemon's unix socket. The real daemon reaches
// remote peers over TCP, but the harness has only the unix socket, so a remote host's reads are served through this
// listener. The scenario fails the reads by refusing new connections and closing the open ones; the TUI and its SDK
// run unchanged. Runs in the test process, so the switch is a plain call.
import type { Socket } from "bun";

/** How long stop() waits for daemon connections that are still connecting or closing. */
const TEARDOWN_WAIT_MS = 5000;
const TEARDOWN_POLL_MS = 20;

interface Pipe {
  readonly client: Socket<Pipe>;
  upstream: Socket<Pipe> | null;
  readonly early: Buffer[];
  /** Client bytes of a request line that has not ended yet; only read when a refusal is configured. */
  pending: string;
  closed: boolean;
  /** The daemon connection opened (the connect callback ran); only an opened connection is counted. */
  upstreamOpen: boolean;
  released: boolean;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export interface TcpRelay {
  readonly port: number;
  /** While failing, new connections are closed at once and open ones are dropped. */
  setFailing(failing: boolean): void;
  /** Connections refused while failing: the proof that a read failed at this boundary. */
  refusedCount(): number;
  /**
   * Closes the listener and every connection. Resolves once each daemon connection the relay opened has closed; rejects
   * when one is still open after the teardown wait, so a leaked daemon connection fails the scenario.
   */
  stop(): Promise<void>;
}

export interface TcpRelayOptions {
  /**
   * The 1-based number of the `notification.list` request without a cursor that is refused: it gets an error reply and is
   * not forwarded. Only that one request fails, so the first page of a host can fail while a later page succeeds.
   */
  readonly refuseNoCursorListAt?: number;
}

export function startTcpRelay(unixTarget: string, options: TcpRelayOptions = {}): TcpRelay {
  let failing = false;
  let refused = 0;
  let connecting = 0;
  let opened = 0;
  let released = 0;
  const pipes = new Set<Pipe>();
  const server = Bun.listen<Pipe>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        // A refused connection is closed before any byte moves; its pipe is marked closed so later callbacks are no-ops.
        const pipe: Pipe = { client, upstream: null, early: [], pending: "", closed: failing, upstreamOpen: false, released: false };
        client.data = pipe;
        if (failing) { refused += 1; client.end(); return; }
        pipes.add(pipe);
        // The daemon side opens asynchronously, so client bytes that arrive first wait for it.
        connecting += 1;
        void Bun.connect<Pipe>({
          unix: unixTarget,
          socket: {
            open(upstream) {
              connecting -= 1;
              opened += 1;
              pipe.upstreamOpen = true;
              upstream.data = pipe;
              // The pipe may have been closed while the connect was pending; the daemon connection is then ended at once.
              if (pipe.closed) { upstream.end(); return; }
              pipe.upstream = upstream;
              for (const chunk of pipe.early.splice(0)) upstream.write(chunk);
            },
            data(_upstream, chunk) { if (!pipe.closed) pipe.client.write(chunk); },
            close() { releaseUpstream(pipe); closePipe(pipe); },
            error() { releaseUpstream(pipe); closePipe(pipe); },
          },
        }).catch(() => {
          connecting -= 1;
          closePipe(pipe);
        });
      },
      data(client, chunk) {
        const pipe = client.data;
        if (options.refuseNoCursorListAt === undefined) { forward(pipe, Buffer.from(chunk)); return; }
        pipe.pending += Buffer.from(chunk).toString("utf8");
        for (let newline = pipe.pending.indexOf("\n"); newline >= 0; newline = pipe.pending.indexOf("\n")) {
          const line = pipe.pending.slice(0, newline + 1);
          pipe.pending = pipe.pending.slice(newline + 1);
          if (isRefusedList(line)) { refuse(pipe, line); continue; }
          forward(pipe, Buffer.from(line));
        }
      },
      close(client) { closePipe(client.data); },
      error(client) { closePipe(client.data); },
    },
  });

  function forward(pipe: Pipe, bytes: Buffer): void {
    if (pipe.upstream === null) pipe.early.push(bytes);
    else pipe.upstream.write(bytes);
  }

  // The counter is per relay: every connection of the host shares it, so the Nth list of the host is the one refused.
  let noCursorLists = 0;
  function isRefusedList(line: string): boolean {
    const request = parseLine(line);
    if (request === null || request["method"] !== "notification.list") return false;
    const params = request["params"] as { cursor?: unknown } | null | undefined;
    if (typeof params?.cursor === "string") return false;
    noCursorLists += 1;
    return noCursorLists === options.refuseNoCursorListAt;
  }

  function refuse(pipe: Pipe, line: string): void {
    const request = parseLine(line) ?? {};
    const reply = { v: request["v"], id: request["id"], err: { class: "daemon", code: "relay_refused", msg: "the relay refuses this list", recover: "" } };
    pipe.client.write(JSON.stringify(reply) + "\n");
  }

  function closePipe(pipe: Pipe): void {
    if (pipe.closed) return;
    pipe.closed = true;
    pipes.delete(pipe);
    pipe.client.end();
    pipe.upstream?.end();
  }

  // Counts a daemon connection once, at its first close or failure; each pipe has at most one.
  function releaseUpstream(pipe: Pipe): void {
    if (!pipe.upstreamOpen || pipe.released) return;
    pipe.released = true;
    released += 1;
  }

  return {
    port: server.port,
    setFailing(next) {
      failing = next;
      if (next) { for (const pipe of [...pipes]) closePipe(pipe); }
    },
    refusedCount: () => refused,
    async stop() {
      for (const pipe of [...pipes]) closePipe(pipe);
      server.stop(true);
      const deadline = Date.now() + TEARDOWN_WAIT_MS;
      while ((connecting > 0 || opened !== released) && Date.now() < deadline) await Bun.sleep(TEARDOWN_POLL_MS);
      if (connecting > 0 || opened !== released) {
        throw new Error(`tcp relay teardown left ${String(connecting)} connecting and ${String(opened - released)} daemon connection(s) open`);
      }
    },
  };
}
