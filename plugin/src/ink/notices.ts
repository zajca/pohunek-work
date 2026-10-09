import type { ControlNotification, ControlSnapshot } from "../control/types.ts";
import type { Logger } from "../log.ts";
import { toAscii } from "../output/sanitize.ts";
import type { NotifyConfig } from "../types/config.ts";
import { noticeArgv } from "../notify-command.ts";
import { exec, SpawnError } from "../util/exec.ts";
import { isUnresolvedAction } from "./attention.ts";

function qualifies(record: ControlNotification): boolean {
  return isUnresolvedAction(record);
}

export class NotificationAnnouncer {
  private readonly seen = new Map<string, Set<string>>();

  public constructor(private readonly config: NotifyConfig, private readonly logger: Logger) {}

  /** First complete snapshot per host is a baseline; later IDs notify only once. */
  public async announce(snapshot: ControlSnapshot): Promise<void> {
    const failedHosts = new Set(snapshot.errors.filter((failure) => failure.scope === "notifications").map((failure) => failure.host));
    const byHost = new Map<string, ControlNotification[]>();
    for (const record of snapshot.notifications) {
      const records = byHost.get(record.host) ?? [];
      records.push(record);
      byHost.set(record.host, records);
    }
    for (const host of snapshot.hosts) {
      if (failedHosts.has(host.route)) continue;
      const records = byHost.get(host.route) ?? [];
      let seen = this.seen.get(host.route);
      if (seen === undefined) {
        seen = new Set(records.map((record) => record.id));
        this.seen.set(host.route, seen);
        continue;
      }
      for (const record of records) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        if (!qualifies(record)) continue;
        const title = record.severity === "error" ? "Pohunek error" : "Pohunek action required";
        const body = toAscii(`${host.name}: ${record.sessionId ?? record.projectId ?? record.id}`);
        try {
          const result = await exec(noticeArgv(this.config, title, body), { timeoutMs: this.config.timeoutMs });
          if (result.timedOut || result.exitCode !== 0) {
            this.logger.error("tui_notice_failed", { host: host.route, id: record.id, exit_code: result.exitCode, timed_out: result.timedOut });
          } else {
            this.logger.info("tui_notice_sent", { host: host.route, id: record.id });
          }
        } catch (error) {
          if (!(error instanceof SpawnError)) throw error;
          this.logger.error("tui_notice_failed", { host: host.route, id: record.id, error });
        }
      }
    }
  }
}
