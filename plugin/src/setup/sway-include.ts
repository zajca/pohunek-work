// Whether a sway config loads the pohunek drop-in. Shared by `setup sway` and
// `doctor` so both reach the same verdict. Only real `include` directives count:
// sway variables set earlier in the file are substituted, environment variables
// and a leading `~` are expanded the way sway's `wordexp` does, a relative
// pattern is taken relative to the config's directory, and the pattern is
// matched as a glob against the drop-in path.
import { readFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";

export interface IncludeContext {
  /** Absolute path of the drop-in file that has to be loaded. */
  readonly dropinPath: string;
  /** Directory of the sway config, the base of relative patterns. */
  readonly configDir: string;
  /** Environment used to expand `$VAR`, `${VAR}` and `~`. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const SET_DIRECTIVE = /^set\s+(\$[A-Za-z0-9_]+)\s+(.*)$/;
const INCLUDE_DIRECTIVE = /^include\s+(.+)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.endsWith(quote) ? trimmed.slice(1, -1) : trimmed;
}

/** Replaces known sway variables, longest name first like sway does. */
function substituteVariables(text: string, variables: ReadonlyMap<string, string>): string {
  let out = text;
  for (const name of [...variables.keys()].sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(name, variables.get(name) ?? "");
  }
  return out;
}

/** Expands `$VAR`, `${VAR}` and a leading `~`; null when a variable is unset. */
function expandEnvironment(text: string, env: IncludeContext["env"]): string | null {
  const unresolved: string[] = [];
  const withHome = text === "~" || text.startsWith("~/") ? `$HOME${text.slice(1)}` : text;
  const expanded = withHome.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced: string | undefined, bare: string | undefined) => {
    const value = env[braced ?? bare ?? ""];
    if (value === undefined) unresolved.push(braced ?? bare ?? "");
    return value ?? "";
  });
  return unresolved.length > 0 ? null : expanded;
}

/** Glob to regular expression: `*` and `?` stay inside one path segment, `[...]` is a character class. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", index + 2);
      if (end < 0) {
        out += "\\[";
      } else {
        const body = pattern.slice(index + 1, end);
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        index = end;
      }
    } else out += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** True when an `include` directive of `contents` loads `context.dropinPath`. */
export function configIncludesDropin(contents: string, context: IncludeContext): boolean {
  const variables = new Map<string, string>();
  const target = normalize(context.dropinPath);
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const set = SET_DIRECTIVE.exec(line);
    if (set !== null) {
      variables.set(set[1] ?? "", unquote(set[2] ?? ""));
      continue;
    }
    const include = INCLUDE_DIRECTIVE.exec(line);
    if (include === null) continue;
    const expanded = expandEnvironment(unquote(substituteVariables(include[1] ?? "", variables)), context.env);
    if (expanded === null || expanded.includes("$")) continue;
    const absolute = expanded.startsWith("/") ? normalize(expanded) : resolve(context.configDir, expanded);
    if (globToRegExp(absolute).test(target)) return true;
  }
  return false;
}

/** Reads `<swayConfigDir>/config`; null when it does not exist or cannot be read. */
export async function readSwayConfig(swayConfigDir: string): Promise<string | null> {
  try {
    return await readFile(join(swayConfigDir, "config"), "utf8");
  } catch {
    return null;
  }
}
