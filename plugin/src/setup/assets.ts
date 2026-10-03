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
import swayIssueBindingTemplate from "../../../launchers/templates/sway-issue-binding.conf.tmpl" with { type: "text" };
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
  /** Quoted command words of the session switcher. */
  readonly launcher: string;
  readonly keybind: string;
  /** The issue picker binding; null leaves it out. */
  readonly issue?: {
    readonly keybind: string;
    /** Quoted command word of the issue picker. */
    readonly launcher: string;
    /** Quoted project argument. */
    readonly project: string;
  };
}

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

/** Fills a template in one pass; a placeholder without a value is an error and a value is never expanded again. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`sway template references unknown variable: ${name}`);
    return value;
  });
}

/** Builds the sway drop-in; the issue picker binding is present only when `values.issue` is given. */
export function renderSwayDropin(values: SwayDropinValues): string {
  const issueBinding =
    values.issue === undefined
      ? ""
      : fill(swayIssueBindingTemplate, {
          issue_keybind: values.issue.keybind,
          issue_launcher: values.issue.launcher,
          project: values.issue.project,
        });
  return fill(swayDropinTemplate, { keybind: values.keybind, launcher: values.launcher, issue_binding: issueBinding });
}
