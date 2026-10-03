// Packs the core TypeScript SDK tarballs (`@pohunek/protocol`, `@pohunek/sdk`,
// `@pohunek/testkit`) from a core checkout at the revision pinned in
// web/core-sdk.json.
//
// usage: bun scripts/pack-core-sdk.ts [--core-checkout DIR] [--out DIR] [--verify-reproducible]
//
// The tarballs are what a core release publishes: core's `pack-release.ts` runs
// with `SOURCE_DATE_EPOCH` set to the pinned commit's time and `--base-url`
// set to the pin's release directory, so the same commit yields the same bytes
// and `bun.lock` integrity values stay valid. `--core-checkout` names an
// existing core clone that must already be at the pinned revision and clean;
// without it a shallow clone is kept in `.core-sdk/core`. `--verify-reproducible`
// packs a second time and fails when any tarball differs.

import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  SDK_PACKAGES,
  WORK_DIR,
  assetName,
  loadPin,
  localServeAddress,
  releaseDirectoryUrl,
  type CoreSdkPin,
} from "./core-sdk";

const execFileAsync = promisify(execFile);
const BUN_EXECUTABLE = process.execPath;
const DEFAULT_CHECKOUT = join(WORK_DIR, "core");
const DEFAULT_OUT = join(WORK_DIR, "assets");
const VERIFY_OUT = join(WORK_DIR, "assets-verify");
const PACK_SCRIPT = join("sdk", "ts", "scripts", "pack-release.ts");
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

interface Options {
  readonly checkout: string | undefined;
  readonly out: string;
  readonly verify: boolean;
}

async function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    cwd,
    env: env ?? process.env,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseOptions(args: readonly string[]): Options {
  let checkout: string | undefined;
  let out = DEFAULT_OUT;
  let verify = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--verify-reproducible") {
      verify = true;
    } else if (arg === "--core-checkout" || arg === "--out") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      index += 1;
      if (arg === "--out") {
        out = resolve(value);
      } else {
        checkout = resolve(value);
      }
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return { checkout, out, verify };
}

// A shallow clone of the pinned revision, created or moved on demand.
async function managedCheckout(pin: CoreSdkPin): Promise<string> {
  if (!(await exists(join(DEFAULT_CHECKOUT, ".git")))) {
    await mkdir(DEFAULT_CHECKOUT, { recursive: true });
    await run("git", ["init", "--quiet"], DEFAULT_CHECKOUT);
    await run("git", ["remote", "add", "origin", pin.coreRepository], DEFAULT_CHECKOUT);
  }
  const head = await run("git", ["rev-parse", "--verify", "-q", "HEAD"], DEFAULT_CHECKOUT).catch(() => "");
  if (head !== pin.coreRev) {
    await run("git", ["fetch", "--quiet", "--depth", "1", "origin", pin.coreRev], DEFAULT_CHECKOUT);
    await run("git", ["checkout", "--quiet", "--detach", "--force", pin.coreRev], DEFAULT_CHECKOUT);
  }
  return DEFAULT_CHECKOUT;
}

async function assertPinnedAndClean(checkout: string, pin: CoreSdkPin): Promise<void> {
  const head = await run("git", ["rev-parse", "HEAD"], checkout);
  if (head !== pin.coreRev) {
    throw new Error(`core checkout ${checkout} is at ${head}, but core-sdk.json pins ${pin.coreRev}`);
  }
  const dirty = await run("git", ["status", "--porcelain"], checkout);
  if (dirty !== "") {
    throw new Error(`core checkout ${checkout} has uncommitted changes; the tarballs would not be reproducible`);
  }
}

async function packInto(checkout: string, pin: CoreSdkPin, out: string, epoch: string): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const stdout = await run(
    BUN_EXECUTABLE,
    [PACK_SCRIPT, "--version", pin.sdkVersion, "--base-url", releaseDirectoryUrl(pin), "--out", out],
    checkout,
    { ...process.env, SOURCE_DATE_EPOCH: epoch },
  );
  process.stdout.write(`${stdout}\n`);
}

async function checksums(directory: string, pin: CoreSdkPin): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const sdkPackage of SDK_PACKAGES) {
    const name = assetName(sdkPackage, pin.sdkVersion);
    result.set(name, (await readFile(join(directory, `${name}.sha256`), "utf8")).split(/\s+/u)[0] ?? "");
  }
  const present = new Set(await readdir(directory));
  for (const name of result.keys()) {
    if (!present.has(name)) {
      throw new Error(`${directory} lacks ${name}`);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const pin = loadPin();
  if (localServeAddress(pin) === undefined) {
    process.stdout.write(`core-sdk.json names a core release (${pin.assetBaseUrl}); nothing to pack\n`);
    return;
  }
  const checkout = options.checkout ?? (await managedCheckout(pin));
  await assertPinnedAndClean(checkout, pin);
  const epoch = await run("git", ["log", "-1", "--format=%ct", pin.coreRev], checkout);
  await run(BUN_EXECUTABLE, ["install", "--frozen-lockfile"], checkout);
  await packInto(checkout, pin, options.out, epoch);
  if (options.verify) {
    await packInto(checkout, pin, VERIFY_OUT, epoch);
    const first = await checksums(options.out, pin);
    const second = await checksums(VERIFY_OUT, pin);
    for (const [name, sha256] of first) {
      if (second.get(name) !== sha256) {
        throw new Error(`${name} is not reproducible: ${sha256} then ${String(second.get(name))}`);
      }
    }
    await rm(VERIFY_OUT, { recursive: true, force: true });
    process.stdout.write(`reproducible: ${first.size} tarballs packed twice with identical bytes\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`pack-core-sdk: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
