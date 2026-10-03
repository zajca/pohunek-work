import { expect, test } from "bun:test";
import { configIncludesDropin, type IncludeContext } from "../../src/setup/sway-include.ts";

const CONTEXT: IncludeContext = {
  dropinPath: "/home/u/.config/sway/config.d/pohunek.conf",
  configDir: "/home/u/.config/sway",
  env: { HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.config" },
};

function includes(config: string, context: IncludeContext = CONTEXT): boolean {
  return configIncludesDropin(config, context);
}

test("an include of the user's config.d glob counts, in every spelling", () => {
  expect(includes("include /home/u/.config/sway/config.d/*\n")).toBe(true);
  expect(includes("include ~/.config/sway/config.d/*\n")).toBe(true);
  expect(includes("include $HOME/.config/sway/config.d/*\n")).toBe(true);
  expect(includes("include ${XDG_CONFIG_HOME}/sway/config.d/*\n")).toBe(true);
  expect(includes("include $XDG_CONFIG_HOME/sway/config.d/*.conf\n")).toBe(true);
  expect(includes("include config.d/*\n")).toBe(true);
  expect(includes("include /home/u/.config/sway/config.d/pohunek.conf\n")).toBe(true);
  expect(includes("  include   /home/u/.config/sway/config.d/p?hunek.conf\n")).toBe(true);
  expect(includes('include "/home/u/.config/sway/config.d/*"\n')).toBe(true);
});

test("sway variables set earlier are substituted", () => {
  expect(includes("set $dir ~/.config/sway\ninclude $dir/config.d/*\n")).toBe(true);
  expect(includes("set $d /home/u/.config/sway/config.d\ninclude $d/*\n")).toBe(true);
  expect(includes("include $dir/config.d/*\nset $dir ~/.config/sway\n")).toBe(false);
});

test("a variable assignment or an include of another directory is not an include of the drop-in", () => {
  expect(includes("set $dir /etc/sway/config.d\n")).toBe(false);
  expect(includes("include /etc/sway/config.d/*\n")).toBe(false);
  expect(includes("set $dir /etc/sway/config.d\ninclude /etc/sway/config.d/*\n")).toBe(false);
  expect(includes("include /home/u/.config/sway/other.d/*\n")).toBe(false);
  expect(includes("include /home/u/.config/sway/config.d\n")).toBe(false);
  expect(includes("include /home/u/.config/sway/config.d/*/x\n")).toBe(false);
  expect(includes("include /home/u/.config/sway/config.d/other.conf\n")).toBe(false);
});

test("comments and lines that merely mention config.d do not count", () => {
  expect(includes("# include ~/.config/sway/config.d/*\n")).toBe(false);
  expect(includes("   # include ~/.config/sway/config.d/*\n")).toBe(false);
  expect(includes("exec echo include /home/u/.config/sway/config.d/*\n")).toBe(false);
  expect(includes("bindsym $mod+x exec ls ~/.config/sway/config.d\n")).toBe(false);
});

test("an unresolvable variable never counts", () => {
  expect(includes("include $MISSING/config.d/*\n")).toBe(false);
  expect(includes("include $dir/config.d/*\n")).toBe(false);
  expect(includes("include ~/.config/sway/config.d/*\n", { ...CONTEXT, env: {} })).toBe(false);
});

test("a glob only matches within one path segment", () => {
  expect(includes("include /home/u/.config/*/config.d/*\n")).toBe(true);
  expect(includes("include /home/u/*/config.d/*\n")).toBe(false);
  expect(includes("include /home/u/.config/sway/config.[a-z]/*\n")).toBe(true);
  expect(includes("include /home/u/.config/sway/config.[!d]/*\n")).toBe(false);
});
