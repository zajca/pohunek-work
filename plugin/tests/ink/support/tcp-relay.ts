// A TCP listener on 127.0.0.1 that forwards every connection to the daemon's unix socket. The real daemon reaches
// remote peers over TCP, but the harness has only the unix socket, so a remote host's reads are served through this
// listener. The scenario fails the reads by refusing new connections and closing the open ones; the TUI and its SDK
// run unchanged. Runs in the test process, so the switch is a plain call.
import type { Socket } from "bun";

interface Pipe {
  readonly client: Socket<Pipe>;
  upstream: Socket<Pipe> | null;
  readonly early: Buffer[];
  closed: boolean;
}

export interface TcpRelay {
  readonly port: number;
  /** While failing, new connections are closed at once and open ones are dropped. */
  setFailing(failing: boolean): void;
  /** Connections refused while failing: the proof that a read failed at this boundary. */
  refusedCount(): number;
  stop(): void;
}

export function startTcpRelay(unixTarget: string): TcpRelay {
  let failing = false;
  let refused = 0;
  const pipes = new Set<Pipe>();
  const server = Bun.listen<Pipe>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        // A refused connection is closed before any byte moves; its pipe is marked closed so later callbacks are no-ops.
        const pipe: Pipe = { client, upstream: null, early: [], closed: failing };
        client.data = pipe;
        if (failing) { refused += 1; client.end(); return; }
        pipes.add(pipe);
        // The daemon side opens asynchronously, so client bytes that arrive first wait for it.
        void Bun.connect<Pipe>({
          unix: unixTarget,
          socket: {
            open(upstream) {
              upstream.data = pipe;
              pipe.upstream = upstream;
              for (const chunk of pipe.early.splice(0)) upstream.write(chunk);
            },
            data(_upstream, chunk) { if (!pipe.closed) pipe.client.write(chunk); },
            close() { closePipe(pipe); },
            error() { closePipe(pipe); },
          },
        }).catch(() => { closePipe(pipe); });
      },
      data(client, chunk) {
        const pipe = client.data;
        if (pipe.upstream === null) pipe.early.push(Buffer.from(chunk));
        else pipe.upstream.write(chunk);
      },
      close(client) { closePipe(client.data); },
      error(client) { closePipe(client.data); },
    },
  });

  function closePipe(pipe: Pipe): void {
    if (pipe.closed) return;
    pipe.closed = true;
    pipes.delete(pipe);
    pipe.client.end();
    pipe.upstream?.end();
  }

  return {
    port: server.port,
    setFailing(next) {
      failing = next;
      if (next) { for (const pipe of [...pipes]) closePipe(pipe); }
    },
    refusedCount: () => refused,
    stop() {
      for (const pipe of [...pipes]) closePipe(pipe);
      server.stop(true);
    },
  };
}
