// Rewrites or verifies the `catalog` of web/package.json from web/core-sdk.json.
//
// usage: bun scripts/sync-core-sdk.ts [--check]
//
// Without `--check` the catalog is rewritten and `bun install` must be run to
// refresh `bun.lock`. With `--check` nothing is written and the exit status is 1
// when the catalog does not match the pin.

import { PACKAGE_JSON_PATH, loadPin, syncCatalogFile } from "./core-sdk";

function main(): number {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`sync-core-sdk: unknown argument ${unknown.join(" ")}\n`);
    return 2;
  }
  const result = syncCatalogFile(PACKAGE_JSON_PATH, loadPin(), !check);
  if (check && result.changed) {
    process.stderr.write("sync-core-sdk: package.json catalog does not match core-sdk.json; run `bun run core-sdk:sync`\n");
    return 1;
  }
  process.stdout.write(result.changed ? "package.json catalog updated\n" : "package.json catalog matches core-sdk.json\n");
  return 0;
}

process.exitCode = main();
