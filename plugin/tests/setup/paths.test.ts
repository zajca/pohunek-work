import { expect, test } from "bun:test";
import { resolveSetupPaths, SetupPathError } from "../../src/setup/paths.ts";

// Vectors taken from the pohunek core path contract (crates/paths/fixtures/runtime-paths.json).
test("explicit XDG overrides win over HOME", () => {
  const paths = resolveSetupPaths({
    XDG_DATA_HOME: "/srv/pohunek data",
    XDG_CONFIG_HOME: "/srv/config",
    HOME: "/home/operator",
  });
  expect(paths).toEqual({
    configHome: "/srv/config",
    configDir: "/srv/config/pohunek",
    dataDir: "/srv/pohunek data/pohunek",
    launcherBinDir: "/srv/pohunek data/pohunek/bin",
    swayConfigDir: "/srv/config/sway",
  });
});

test("HOME supplies the documented defaults", () => {
  const paths = resolveSetupPaths({ HOME: "/Users/Alice Name" });
  expect(paths.configDir).toBe("/Users/Alice Name/.config/pohunek");
  expect(paths.launcherBinDir).toBe("/Users/Alice Name/.local/share/pohunek/bin");
  expect(paths.swayConfigDir).toBe("/Users/Alice Name/.config/sway");
});

test("one XDG variable can be set while the other falls back to HOME", () => {
  const paths = resolveSetupPaths({ XDG_CONFIG_HOME: "/srv/config", HOME: "/home/u" });
  expect(paths.configDir).toBe("/srv/config/pohunek");
  expect(paths.launcherBinDir).toBe("/home/u/.local/share/pohunek/bin");
});

test("without XDG variables and HOME the error names both", () => {
  expect(() => resolveSetupPaths({})).toThrow(new SetupPathError("missing XDG_DATA_HOME or HOME"));
});

test("a set but empty XDG variable is an error, never a fallback", () => {
  expect(() => resolveSetupPaths({ XDG_DATA_HOME: "", HOME: "/home/u" })).toThrow("XDG_DATA_HOME is not usable: it is empty");
});

test("relative, parent-component and NUL values are refused", () => {
  expect(() => resolveSetupPaths({ XDG_CONFIG_HOME: "config", HOME: "/h" })).toThrow("XDG_CONFIG_HOME is not usable: it is not an absolute path");
  expect(() => resolveSetupPaths({ XDG_CONFIG_HOME: "/a/../b", HOME: "/h" })).toThrow("it contains a `..` component");
  expect(() => resolveSetupPaths({ XDG_DATA_HOME: "/a\0b", HOME: "/h" })).toThrow("it contains a NUL byte");
  expect(() => resolveSetupPaths({ HOME: "relative" })).toThrow("HOME is not usable: it is not an absolute path");
});

test("a dotted name that is not a parent component is accepted", () => {
  expect(resolveSetupPaths({ HOME: "/home/a..b" }).configHome).toBe("/home/a..b/.config");
});
