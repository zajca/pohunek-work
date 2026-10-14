// One daemon connection of the control client, on the public TypeScript SDK of the pinned core
// release. A link lists sessions and notifications and follows the daemon's event stream; any
// event asks the client to read the link again. The link never reports a failed read as empty.
import { ClientError, Client, nextRequestId, SUPPORTED_PROTOCOL_VERSIONS, type Subscription } from "@pohunek/sdk";
import type { NotificationStatus } from "@pohunek/protocol";
import { array, notification, object, session, sessionOutput, InvalidControlResponse } from "./decode.ts";
import type { ControlError, ControlNotification, ControlOutput, ControlOutputRequest, ControlResult, ControlSession } from "./types.ts";

/** Notification statuses the overview shows; every one is read on each listing. */
export const VISIBLE_NOTIFICATION_STATUSES: readonly NotificationStatus[] = ["unread", "read", "acknowledged", "archived"];

/** A daemon call or connection that did not complete within its bound; the outcome of the call is unknown. */
export class SdkTimeoutError extends Error {}

/** A daemon refusal or a failed connection, as the control client reports it. */
export function sdkFailure(error: unknown): ControlError {
  if (error instanceof SdkTimeoutError) return { code: "timeout", message: error.message };
  if (error instanceof ClientError) return { code: "command_failed", message: error.message, cliCode: error.code, cliClass: error.errorClass };
  if (error instanceof InvalidControlResponse) return { code: "invalid_response", message: error.message };
  const message = error instanceof Error ? error.message : "daemon connection failed";
  return { code: "unavailable", message };
}

/**
 * A daemon refusal arrives over a healthy connection, so only these client errors keep it. Any other client
 * error (timeout, framing, I/O, unreachable daemon) can leave the connection unusable, so it is reset.
 */
const REFUSAL_KINDS: ReadonlySet<string> = new Set(["protocol", "remoteProtocol", "daemonProtocolTooOld"]);

/**
 * Doublings of the retry delay before it reaches the cap: the first retry waits `cap / 2^steps`. The base is
 * derived from the cap, so `reconnect_max_secs` is the only timing value of the reconnect.
 */
const RECONNECT_BACKOFF_STEPS = 6;

export class SdkLink {
  private client: Client | null = null;
  private subscriptionClient: Client | null = null;
  private pending: Promise<Client> | null = null;
  private subscription: Subscription | null = null;
  private closed = false;
  /** True from the loss of the event stream until a retry connects; calls fail at once meanwhile. */
  private reconnecting = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** The last queued call; the next call starts after it settles. */
  private inFlight: Promise<void> = Promise.resolve();

  public constructor(
    public readonly route: string,
    private readonly connect: () => Promise<Client>,
    private readonly onEvent: () => void,
    private readonly timeoutMs: number,
    private readonly reconnectMaxMs: number,
  ) {}

  /** The connected client; connects, checks the daemon's health and starts the event stream on first use. */
  private async ready(): Promise<Client> {
    if (this.client !== null) return this.client;
    this.pending ??= this.open();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  /** A subscription consumes its connection, so reads and the event stream use two connections, as the web client does. */
  private async open(): Promise<Client> {
    const client = await this.healthy();
    let subscriptionClient: Client | null = null;
    try {
      subscriptionClient = await this.healthy();
      const subscription = await subscriptionClient.subscribe({ v: SUPPORTED_PROTOCOL_VERSIONS, id: nextRequestId("subscribe"), method: "subscribe", params: null });
      if (this.closed) throw new Error("the link was closed while it connected");
      this.client = client;
      this.subscriptionClient = subscriptionClient;
      this.subscription = subscription;
      void this.follow(subscription);
      return client;
    } catch (error) {
      await subscriptionClient?.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async healthy(): Promise<Client> {
    const client = await this.connect();
    try {
      const health = await client.call("daemon.health", null);
      if (health.status !== "ok") throw new InvalidControlResponse(`daemon reports status ${health.status}`);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async follow(subscription: Subscription): Promise<void> {
    try {
      for (;;) {
        const event = await subscription.nextEvent();
        if (event === null) break;
        if (!this.closed) this.onEvent();
      }
    } catch {
      // A broken stream ends the link; the next listing reconnects and reports the cause.
    }
    if (this.subscription === subscription) {
      await this.drop();
      this.startReconnect();
    }
  }

  /**
   * Starts the retry loop once per outage. The first event asks the client to read the link, and that read
   * fails at once with "reconnecting to the daemon", so the snapshot shows the outage while the list is kept.
   */
  private startReconnect(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.attempt = 0;
    this.onEvent();
    this.scheduleAttempt();
  }

  private scheduleAttempt(): void {
    const delay = this.reconnectMaxMs / 2 ** Math.max(0, RECONNECT_BACKOFF_STEPS - this.attempt);
    this.attempt += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.retryConnect();
    }, delay);
  }

  /** One reconnect attempt; a connected link reconciles through the same read an event triggers. */
  private async retryConnect(): Promise<void> {
    try {
      await this.ready();
    } catch {
      if (!this.closed) this.scheduleAttempt();
      return;
    }
    if (this.closed) return;
    // The stream can end while the attempt awaits its connection; that end was not started as a new loop.
    if (this.subscription === null) {
      this.scheduleAttempt();
      return;
    }
    this.reconnecting = false;
    this.attempt = 0;
    this.onEvent();
  }

  /** Forgets a connection that ended, so the next read reconnects. */
  private async drop(): Promise<void> {
    const client = this.client;
    const subscriptionClient = this.subscriptionClient;
    this.client = null;
    this.subscriptionClient = null;
    this.subscription = null;
    await Promise.all([client?.close(), subscriptionClient?.close()].map(async (closing) => { await closing?.catch(() => undefined); }));
  }

  /**
   * Calls a daemon method within `timeoutMs`; a timed-out or failed connection is reset so the next call reconnects.
   * A timed-out call is not retried here, because its effect on the daemon is unknown.
   */
  public async call<T>(method: string, params: unknown, timeoutMs: number = this.timeoutMs): Promise<T> {
    // Commands are not queued during an outage: they fail now and the caller reports them as unavailable.
    if (this.reconnecting) throw new Error("reconnecting to the daemon");
    const run = this.inFlight.then(() => this.exchange<T>(method, params, timeoutMs));
    this.inFlight = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Runs one request; calls on a link are queued in `call`, because the SDK pairs each reply with the request in flight. */
  private async exchange<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    try {
      const client = await this.bounded(this.ready(), timeoutMs);
      return await this.bounded((client.call as (m: string, p: unknown) => Promise<T>).call(client, method, params), timeoutMs);
    } catch (error) {
      if (error instanceof ClientError && REFUSAL_KINDS.has(error.kind)) throw error;
      await this.drop();
      this.startReconnect();
      throw error;
    }
  }

  private async bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new SdkTimeoutError(`no daemon response within ${String(timeoutMs)} ms`)); }, timeoutMs);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  public async sessions(): Promise<ControlResult<readonly ControlSession[]>> {
    try {
      const raw = await this.call<unknown>("session.list", {});
      return { ok: true, data: array(raw, "$").map((item, index) => session(item, `$[${String(index)}]`, this.route)) };
    } catch (error) {
      return { ok: false, error: sdkFailure(error) };
    }
  }

  public async notifications(pageSize: number): Promise<ControlResult<readonly ControlNotification[]>> {
    const records: ControlNotification[] = [];
    try {
      for (const status of VISIBLE_NOTIFICATION_STATUSES) {
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page: unknown = await this.call<unknown>("notification.list", { status, limit: pageSize, ...(cursor === null ? {} : { cursor }) });
          const obj = object(page, "$");
          records.push(...array(obj["notifications"], "$.notifications").map((item, index) => notification(item, `$.notifications[${String(index)}]`, this.route)));
          const next = obj["next_cursor"];
          if (next !== undefined && next !== null && (typeof next !== "string" || next === "")) {
            throw new InvalidControlResponse("$.next_cursor: expected a non-empty string");
          }
          cursor = typeof next === "string" ? next : null;
          if (cursor !== null && seen.has(cursor)) throw new InvalidControlResponse("daemon returned a repeated notifications cursor");
          if (cursor !== null) seen.add(cursor);
        } while (cursor !== null);
      }
      return { ok: true, data: records };
    } catch (error) {
      return { ok: false, error: sdkFailure(error) };
    }
  }

  /** One replay of retained output; without a cursor it returns the newest tail, and with one it waits up to `waitMs` at the end. */
  public async output(sessionId: string, request: ControlOutputRequest): Promise<ControlResult<ControlOutput>> {
    const params = {
      session_id: sessionId,
      max_bytes: request.maxBytes,
      ...(request.after === null || request.runtime === null ? {} : { runtime: { worker_instance_id: request.runtime.workerInstanceId, runtime_generation: request.runtime.runtimeGeneration } }),
      ...(request.after === null ? {} : { after_offset: request.after }),
      ...(request.after === null ? {} : { wait_ms: request.waitMs }),
    };
    try {
      // The daemon holds the reply for up to `waitMs` at the end of the output, so the bound includes that wait.
      return { ok: true, data: sessionOutput(await this.call<unknown>("session.output", params, this.timeoutMs + request.waitMs), "$") };
    } catch (error) {
      return { ok: false, error: sdkFailure(error) };
    }
  }

  /** Runs a method and maps the reply or the failure to the control client's result. */
  public async request(method: string, params: unknown): Promise<ControlResult<unknown>> {
    try {
      return { ok: true, data: await this.call<unknown>(method, params) };
    } catch (error) {
      return { ok: false, error: sdkFailure(error) };
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    await this.drop();
  }
}
