import type { ControlNotification } from "../control/types.ts";

export function isUnresolvedAction(record: ControlNotification): boolean {
  if (record.status === "archived" || record.status === "deleted" || record.status === "acknowledged") return false;
  return record.severity === "action_required" || record.severity === "error" ||
    record.kind === "agent_blocked" || record.kind === "approval_required";
}
