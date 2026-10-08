import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CONFIG_ASSETS, SCRIPT_ASSETS } from "../../src/setup/assets.ts";

const LAUNCHERS = new URL("../../../launchers/", import.meta.url);

async function source(name: string): Promise<string> {
  return readFile(new URL(name, LAUNCHERS), "utf8");
}

test("embedded scripts are byte-identical to the files under launchers/", async () => {
  expect(SCRIPT_ASSETS.map((asset) => asset.name).sort()).toEqual(
    ["lib.sh", "pohunek-launch-issue", "pohunek-launch-pr", "pohunek-rofi", "pohunek-rofi-issue"],
  );
  for (const asset of SCRIPT_ASSETS) {
    expect(asset.body).toBe(await source(asset.name));
  }
});

test("config assets are byte-identical to the templates under launchers/templates", async () => {
  for (const asset of CONFIG_ASSETS) {
    expect(asset.body).toBe(await source(`templates/${asset.name}`));
  }
  expect(CONFIG_ASSETS.map((asset) => asset.name)).toEqual([
    "launcher.conf",
    "prompts/issue.tmpl",
    "prompts/pr.tmpl",
    "prompts/review.tmpl",
  ]);
});
