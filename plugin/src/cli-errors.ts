// Error output shared by the command line entry point.
import { buildErrorEnvelope } from "./output/list.ts";
import { toAsciiLines } from "./output/sanitize.ts";
import pkg from "../package.json" with { type: "json" };

/** Failed command; the pohunek CLI uses the same value for errors. */
export const EXIT_ERROR = 2;

export type ErrorClass = "configuration" | "usage" | "internal" | "action";

/**
 * Prints the error as a JSON envelope under --json, and in strict ASCII on stderr
 * otherwise: messages can carry text from pohunek or a provider. `contract` is
 * the failing command's envelope version.
 */
export function reportError(json: boolean, contract: number, errorClass: ErrorClass, code: string, message: string): number {
  if (json) {
    const err = { class: errorClass, code, msg: message };
    console.log(JSON.stringify(buildErrorEnvelope(pkg.version, err, contract), null, 2));
  } else {
    console.error(toAsciiLines(message).join("\n"));
  }
  return EXIT_ERROR;
}
