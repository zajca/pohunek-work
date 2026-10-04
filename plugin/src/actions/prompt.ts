// Prompt rendering. Provider text (titles) reaches the prompt only inside a
// fenced data block; the fence carries a hash of the block text, so the text
// cannot contain its own closing line.
import { createHash } from "node:crypto";
import { sanitizeCell } from "../output/sanitize.ts";
import adoptHeadCheck from "../../prompts/work-adopt-head-check.tmpl" with { type: "text" };
import babysit from "../../prompts/work-babysit.tmpl" with { type: "text" };
import fixCi from "../../prompts/work-fix-ci.tmpl" with { type: "text" };
import implementGithub from "../../prompts/work-implement-github.tmpl" with { type: "text" };
import implement from "../../prompts/work-implement.tmpl" with { type: "text" };
import rebase from "../../prompts/work-rebase.tmpl" with { type: "text" };
import review from "../../prompts/work-review.tmpl" with { type: "text" };

const FENCE_HASH_LENGTH = 16;
const PLACEHOLDER = /\$\{([a-z_]+)\}/g;

export type PromptName = "work-adopt-head-check" | "work-implement" | "work-implement-github" | "work-babysit" | "work-fix-ci" | "work-rebase" | "work-review";

/** Templates are bundled into the program text, so a compiled binary needs no files beside it. */
const TEMPLATES: Readonly<Record<PromptName, string>> = {
  "work-adopt-head-check": adoptHeadCheck,
  "work-implement": implement,
  "work-implement-github": implementGithub,
  "work-babysit": babysit,
  "work-fix-ci": fixCi,
  "work-rebase": rebase,
  "work-review": review,
};

export function readTemplate(name: PromptName): Promise<string> {
  return Promise.resolve(TEMPLATES[name]);
}

/** Multi-line provider text inside a data block: the first `maxLength` characters, every line behind `TEXT_LINE_PREFIX`. */
export interface TextField {
  readonly name: string;
  readonly value: string;
  readonly maxLength: number;
}

/** Marks every line of a text field, so no line of it can start with a fence. */
const TEXT_LINE_PREFIX = "| ";
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;

function textLines(text: TextField): string[] {
  const characters = Array.from(text.value);
  const kept = characters.length > text.maxLength ? characters.slice(0, text.maxLength).join("") : text.value;
  const heading =
    kept === text.value
      ? `${text.name} (each line starts with "${TEXT_LINE_PREFIX.trimEnd()}"):`
      : `${text.name} (each line starts with "${TEXT_LINE_PREFIX.trimEnd()}"; cut to the first ${text.maxLength.toString()} of ${characters.length.toString()} characters):`;
  if (kept.trim() === "") return [`${text.name}: (empty)`];
  return [heading, ...kept.split(LINE_BREAK).map((line) => `${TEXT_LINE_PREFIX}${sanitizeCell(line)}`)];
}

/**
 * Wraps provider fields as `name: value` lines between fence lines. Control
 * characters (terminal escapes, line breaks) in values become spaces. An
 * optional text field keeps its lines, each behind `TEXT_LINE_PREFIX`, so it
 * can neither start a fence line nor carry a control character.
 */
export function dataBlock(source: string, fields: Readonly<Record<string, string>>, text?: TextField): string {
  const body = [
    ...Object.entries(fields).map(([name, value]) => `${name}: ${sanitizeCell(value)}`),
    ...(text === undefined ? [] : textLines(text)),
  ].join("\n");
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
