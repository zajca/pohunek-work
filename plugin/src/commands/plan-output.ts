// Plan output shared by the commands that show a plan before they act (`do`,
// `manager start`): the shown command line, terminal text, the JSON envelope
// and the confirmation.
import { ActionError } from "../actions/types.ts";
import { toAsciiLines } from "../output/sanitize.ts";

const SAFE_ARG = /^[A-Za-z0-9_./:=@%+,-]+$/;

/** Display only: quotes elements that a shell would split or interpret. */
function quote(arg: string): string {
  return SAFE_ARG.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

export function commandLine(argv: readonly string[]): string {
  return argv.map(quote).join(" ");
}

/**
 * Text for the terminal in strict ASCII: the plan carries provider text (titles
 * in the prompt, branch names, session names). JSON output and the prompt sent
 * on stdin stay unchanged.
 */
export function display(text: string): string {
  return toAsciiLines(text).join("\n");
}

/** The success envelope of a command whose `--json` contract has version `contract`. */
export function envelope(cliVersion: string, contract: number, ok: Record<string, unknown>): string {
  return JSON.stringify({ cli_version: cliVersion, protocol: { minimum: contract, maximum: contract }, ok }, null, 2);
}

/** Asks the owner to confirm the shown command; null when there is no terminal. */
export type Confirm = ((question: string) => Promise<boolean>) | null;

/** Shows the plan and asks unless `--yes`; refuses without a terminal or an explicit yes. */
export async function confirmPlan(yes: boolean, confirm: Confirm, text: string): Promise<void> {
  if (yes) return;
  if (confirm === null) {
    throw new ActionError("confirmation_required", "no terminal to confirm on: pass --yes after reviewing --dry-run");
  }
  console.error(display(text));
  if (!(await confirm("Run this command?"))) {
    throw new ActionError("confirmation_required", "not confirmed; nothing was executed");
  }
}
