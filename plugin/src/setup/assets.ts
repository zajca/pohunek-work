// The launcher files `pohunek-work setup` installs. They are imported as text
// modules, so the same bytes are available from a `bun`-run bin and from a
// `bun build --compile` binary: a compiled binary has no source tree to read
// the scripts from at run time.
import libSh from "../../../launchers/lib.sh" with { type: "text" };
import pohunekLaunchIssue from "../../../launchers/pohunek-launch-issue" with { type: "text" };
import pohunekLaunchPr from "../../../launchers/pohunek-launch-pr" with { type: "text" };
import pohunekRofi from "../../../launchers/pohunek-rofi" with { type: "text" };
import pohunekRofiIssue from "../../../launchers/pohunek-rofi-issue" with { type: "text" };
import launcherConf from "../../../launchers/templates/launcher.conf" with { type: "text" };
import issueTemplate from "../../../launchers/templates/prompts/issue.tmpl" with { type: "text" };
import prTemplate from "../../../launchers/templates/prompts/pr.tmpl" with { type: "text" };
import reviewTemplate from "../../../launchers/templates/prompts/review.tmpl" with { type: "text" };
import swayDropinTemplate from "../../../launchers/templates/sway-dropin.conf.tmpl" with { type: "text" };

export interface Asset {
  /** Path relative to the install directory. */
  readonly name: string;
  readonly body: string;
}

/** Scripts share one directory: `pohunek-rofi` and the launchers source `lib.sh` as a sibling. */
export const SCRIPT_ASSETS: readonly Asset[] = [
  { name: "lib.sh", body: libSh },
  { name: "pohunek-rofi", body: pohunekRofi },
  { name: "pohunek-launch-issue", body: pohunekLaunchIssue },
  { name: "pohunek-rofi-issue", body: pohunekRofiIssue },
  { name: "pohunek-launch-pr", body: pohunekLaunchPr },
];

/** Starter files below the pohunek config directory. */
export const CONFIG_ASSETS: readonly Asset[] = [
  { name: "launcher.conf", body: launcherConf },
  { name: "prompts/issue.tmpl", body: issueTemplate },
  { name: "prompts/pr.tmpl", body: prTemplate },
  { name: "prompts/review.tmpl", body: reviewTemplate },
];

export interface SwayDropinValues {
  readonly launcher: string;
  readonly issue_launcher: string;
  readonly keybind: string;
  readonly issue_keybind: string;
}

/** Variables the sway drop-in template may reference. */
const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

/** Fills the sway drop-in template; a placeholder without a value is an error, never left in the output. */
export function renderSwayDropin(values: SwayDropinValues, template: string = swayDropinTemplate): string {
  const known = new Map<string, string>(Object.entries(values));
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = known.get(name);
    if (value === undefined) throw new Error(`sway drop-in template references unknown variable: ${name}`);
    return value;
  });
}
