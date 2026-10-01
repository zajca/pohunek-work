// `attach`: puts the owner's terminal on the one live session linked to a row.
import type { CollectedRow } from "../commands/list.ts";
import { isLiveSession, type PohunekClient } from "../sources/pohunek.ts";
import type { PluginConfig } from "../types/config.ts";
import { ActionError, type AttachPlan } from "./types.ts";

/** A session id as pohunek prints it; never an option, since it is passed as an argv value. */
const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export function planAttach(row: CollectedRow, config: PluginConfig): AttachPlan {
  const pohunek = row.listItem.sources.pohunek;
  // Without pohunek data the row has no sessions, which is not the same as no live session.
  if (pohunek !== "ok") {
    throw new ActionError("source_unavailable", `attach refused: pohunek did not answer (${pohunek})`);
  }
  const live = row.item.sessions.filter(isLiveSession);
  const [only] = live;
  if (only === undefined) {
    throw new ActionError("no_session", `attach refused: no live linked session runs for ${row.listItem.key}`);
  }
  if (live.length > 1) {
    throw new ActionError(
      "ambiguous_session",
      `attach refused: several live linked sessions run for ${row.listItem.key} (${live.map((s) => s.id).join(", ")}); run \`pohunek attach <id>\` with one of them`,
    );
  }
  if (!SESSION_ID.test(only.id)) {
    throw new ActionError("invalid_value", `session id ${JSON.stringify(only.id)} is not a pohunek session id`);
  }
  return {
    action: "attach",
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    sessionId: only.id,
    argv: [config.global.pohunek.bin, "attach", only.id],
  };
}

/** Returns once the owner detaches; a failed start or a non-zero exit is a typed error. */
export async function executeAttach(plan: AttachPlan, pohunek: PohunekClient): Promise<void> {
  const attached = await pohunek.attach(plan.sessionId);
  if (!attached.ok) {
    throw new ActionError("command_failed", `pohunek attach failed (${attached.code}: ${attached.message})`);
  }
  if (attached.data !== 0) {
    throw new ActionError("command_failed", `pohunek attach exited with code ${String(attached.data)}`);
  }
}
