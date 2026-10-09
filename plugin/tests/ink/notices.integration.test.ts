import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlNotification, ControlSnapshot } from "../../src/control/types.ts";
import { NotificationAnnouncer } from "../../src/ink/notices.ts";
import { createLogger } from "../../src/log.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(id: string, kind: string, severity: string): ControlNotification {
  return { host: "local", id, kind, severity, status: "unread", title: "unsafe <b>$(cmd)</b>", body: "ignored", createdAt: "2026-10-09T10:00:00Z", sessionId: "session-1", projectId: null };
}

function snapshot(notifications: readonly ControlNotification[], failed = false): ControlSnapshot {
  return {
    hosts: [{ route: "local", dialable: true, name: "Local", classification: "local", daemonVersion: "0.33.1", address: null }],
    sessions: [], projects: [], notifications,
    errors: failed ? [{ host: "local", scope: "notifications", error: { code: "unavailable", message: "offline" } }] : [],
  };
}

test("the TUI announces only new actionable notification IDs through a notifier process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pohunek-tui-notices-"));
  roots.push(root);
  const binary = join(root, "notify-send");
  const calls = join(root, "calls");
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);
  await chmod(binary, 0o755);
  const logger = createLogger({ logDir: join(root, "logs"), command: "tui", maxStringLength: 1024 });
  try {
    const announcer = new NotificationAnnouncer({ command: binary, timeoutMs: 2000 }, logger);
    await announcer.announce(snapshot([record("old", "approval_required", "action_required")]));
    expect(await Bun.file(calls).exists()).toBe(false);
    await announcer.announce(snapshot([record("old", "approval_required", "action_required"), record("quiet", "information", "info"), record("new", "agent_blocked", "warning")]));
    await announcer.announce(snapshot([record("new", "agent_blocked", "warning")]));
    await announcer.announce(snapshot([record("missed", "error", "error")], true));
    await announcer.announce(snapshot([record("missed", "error", "error")]));
    const lines = (await readFile(calls, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Pohunek action required");
    expect(lines[1]).toContain("Pohunek error");
    expect(lines.join("\n")).not.toContain("$(cmd)");
  } finally {
    await logger.close();
  }
});
