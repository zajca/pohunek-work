// Process-boundary relay between the control client and the real daemon socket, for the scenarios that need a
// notification reply to arrive late. The pinned daemon answers at once and has no setting that delays a reply,
// so the relay holds the replies to `notification.list` while its gate is closed. Every other byte is forwarded
// unchanged and in order. The relay counts the `notification.list` requests, which the scenarios use to tell a
// full notification read from an event that applies one change.
import type { Socket } from "bun";

export interface ControlRelay {
  readonly socket: string;
  /** Number of `notification.list` requests the client has sent through the relay. */
  readonly notificationListRequests: () => number;
  /** Number of notification records the daemon returned in the replies to `notification.list` requests. */
  readonly notificationRecordsReturned: () => number;
  /** Holds the replies to `notification.list` until `release` is called; replies to other methods are not held. */
  readonly holdNotificationLists: () => void;
  readonly release: () => void;
  readonly stop: () => void;
}

interface Link {
  client: Socket<Link> | null;
  upstream: Socket<Link> | null;
  /** Client bytes received before the daemon connection is open. */
  queued: Uint8Array[];
  clientText: string;
  upstreamText: string;
  /** Replies are written in the order the daemon sent them, so a held reply holds the lines behind it. */
  replies: Promise<void>;
}

const LIST_METHOD = "notification.list";

function completeLines(buffered: string): { lines: string[]; rest: string } {
  const parts = buffered.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

/** The records a `notification.list` reply carries; a refusal carries none. */
function notificationRecords(reply: Record<string, unknown> | null): number {
  const ok = reply?.["ok"];
  const list = typeof ok === "object" && ok !== null ? (ok as Record<string, unknown>)["notifications"] : undefined;
  return Array.isArray(list) ? list.length : 0;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function startControlRelay(upstreamSocket: string, socketPath: string): ControlRelay {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let listRequests = 0;
  let listRecords = 0;
  // Ids of `notification.list` requests whose replies have not come back yet.
  const listIds = new Set<string>();
  let gate: Promise<void> | null = null;
  let openGate: () => void = () => undefined;

  const upstreamHandlers = {
    data(upstream: Socket<Link>, chunk: Uint8Array): void {
      const link = upstream.data;
      const split = completeLines(link.upstreamText + decoder.decode(chunk, { stream: true }));
      link.upstreamText = split.rest;
      for (const line of split.lines) {
        link.replies = link.replies.then(async () => {
          const parsed = parseLine(line);
          const id = typeof parsed?.["id"] === "string" ? parsed["id"] : null;
          if (id !== null && listIds.delete(id)) {
            listRecords += notificationRecords(parsed);
            if (gate !== null) await gate;
          }
          link.client?.write(encoder.encode(`${line}\n`));
        });
      }
    },
    close(): void {},
    error(): void {},
  };

  const listener = Bun.listen<Link>({
    unix: socketPath,
    socket: {
      open(client): void {
        const link: Link = { client, upstream: null, queued: [], clientText: "", upstreamText: "", replies: Promise.resolve() };
        client.data = link;
        void Bun.connect<Link>({ unix: upstreamSocket, data: link, socket: upstreamHandlers }).then(upstream => {
          link.upstream = upstream;
          for (const chunk of link.queued.splice(0)) upstream.write(chunk);
        }, () => { client.end(); });
      },
      data(client, chunk): void {
        const link = client.data;
        const split = completeLines(link.clientText + decoder.decode(chunk, { stream: true }));
        link.clientText = split.rest;
        for (const line of split.lines) {
          const parsed = parseLine(line);
          if (parsed?.["method"] !== LIST_METHOD) continue;
          listRequests += 1;
          if (typeof parsed["id"] === "string") listIds.add(parsed["id"]);
        }
        if (link.upstream === null) link.queued.push(chunk);
        else link.upstream.write(chunk);
      },
      close(client): void {
        client.data.upstream?.end();
      },
      error(): void {},
    },
  });

  return {
    socket: socketPath,
    notificationListRequests: () => listRequests,
    notificationRecordsReturned: () => listRecords,
    holdNotificationLists() {
      gate ??= new Promise<void>(resolve => { openGate = resolve; });
    },
    release() {
      openGate();
      gate = null;
    },
    stop() {
      listener.stop(true);
    },
  };
}
