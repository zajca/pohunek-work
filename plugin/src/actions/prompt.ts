// Prompt rendering. Provider text (titles) reaches the prompt only inside a
// fenced data block; the fence carries a hash of the block text, so the text
// cannot contain its own closing line.
import { createHash } from "node:crypto";
import { sanitizeCell } from "../output/sanitize.ts";
import babysit from "../../prompts/work-babysit.tmpl" with { type: "text" };
import fixCi from "../../prompts/work-fix-ci.tmpl" with { type: "text" };
import implement from "../../prompts/work-implement.tmpl" with { type: "text" };
import rebase from "../../prompts/work-rebase.tmpl" with { type: "text" };
import review from "../../prompts/work-review.tmpl" with { type: "text" };

const FENCE_HASH_LENGTH = 16;
const PLACEHOLDER = /\$\{([a-z_]+)\}/g;

export type PromptName = "work-implement" | "work-babysit" | "work-fix-ci" | "work-rebase" | "work-review";

/** Templates are bundled into the program text, so a compiled binary needs no files beside it. */
const TEMPLATES: Readonly<Record<PromptName, string>> = {
  "work-implement": implement,
  "work-babysit": babysit,
  "work-fix-ci": fixCi,
  "work-rebase": rebase,
  "work-review": review,
};

export function readTemplate(name: PromptName): Promise<string> {
  return Promise.resolve(TEMPLATES[name]);
}

/**
 * Wraps provider fields as `name: value` lines between fence lines. Control
 * characters (terminal escapes, line breaks) in values become spaces.
 */
export function dataBlock(source: string, fields: Readonly<Record<string, string>>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `${name}: ${sanitizeCell(value)}`)
    .join("\n");
  const hash = createHash("sha256").update(source).update("\n").update(body).digest("hex").slice(0, FENCE_HASH_LENGTH);
  return `<<<UNTRUSTED DATA ${hash} source=${source}\n${body}\n>>>END UNTRUSTED DATA ${hash}`;
}

/**
 * Replaces every `${name}` in one pass, so a value is never scanned again for
 * placeholders. An unknown placeholder or an unused variable is an error.
 */
export function renderTemplate(template: string, variables: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`prompt template uses unknown placeholder \${${name}}`);
    used.add(name);
    return value;
  });
  const unused = Object.keys(variables).filter((name) => !used.has(name));
  if (unused.length > 0) throw new Error(`prompt variables not used by the template: ${unused.join(", ")}`);
  return rendered;
}
