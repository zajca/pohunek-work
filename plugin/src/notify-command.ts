import { basename } from "node:path";
import type { NotifyConfig } from "./types/config.ts";

/** Pass untrusted title and body as arguments, never as AppleScript source or shell text. */
export function noticeArgv(notify: NotifyConfig, title: string, body: string): readonly string[] {
  if (basename(notify.command) === "osascript") {
    return [notify.command, "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body];
  }
  return [notify.command, "--app-name=pohunek-work", "--", title, body];
}
