import type { ControlNotification } from "./types.ts";

/** Digits of a daemon timestamp's fraction after padding; the daemon writes nanoseconds and drops trailing zeros. */
const FRACTION_DIGITS = 9;
const TIMESTAMP = /^(.+?)(?:\.(\d+))?Z$/;

/** A timestamp whose fraction is padded to the same width, so that a string comparison orders it by time. */
function sortableTimestamp(value: string): string {
  const parts = TIMESTAMP.exec(value);
  if (parts === null) return value;
  return `${parts[1] ?? ""}.${(parts[2] ?? "").padEnd(FRACTION_DIGITS, "0")}Z`;
}

/**
 * The activity order: newer records first, by creation time, then by id and host. Two records of one time keep a
 * fixed order, so a page boundary inside that time does not split or repeat them. Negative when `left` comes first.
 */
export function compareActivityOrder(left: ControlNotification, right: ControlNotification): number {
  const leftTime = sortableTimestamp(left.createdAt);
  const rightTime = sortableTimestamp(right.createdAt);
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
  if (left.id !== right.id) return left.id < right.id ? 1 : -1;
  if (left.host !== right.host) return left.host < right.host ? -1 : 1;
  return 0;
}
