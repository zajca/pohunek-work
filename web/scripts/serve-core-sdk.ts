// Serves the packed core SDK tarballs at the loopback address web/core-sdk.json
// names, the way a core release serves them.
//
// usage: bun scripts/serve-core-sdk.ts [--dir DIR] [--pin FILE] [--run COMMAND [ARG...]]
//
// Without a command the server runs until interrupted. With a command it
// serves while the command runs and exits with the command's status, so
// `bun scripts/serve-core-sdk.ts --run bun install --frozen-lockfile` needs no
// second terminal. A pin that names a core release has nothing to serve.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WORK_DIR, assetName, loadPin, localServeAddress, SDK_PACKAGES, type CoreSdkPin } from "./core-sdk";

const DEFAULT_DIR = join(WORK_DIR, "assets");
const ASSET_NAME_PATTERN = /^pohunek-ts-[a-z]+-[0-9A-Za-z.-]+\.tgz$/u;
const SERVED_PATH_PATTERN = /^\/releases\/download\/v[^/]+\/[^/]+$/u;

export interface ServedAssets {
  readonly url: string;
  stop(): Promise<void>;
}

// Serves `<directory>/<asset>` for `GET /releases/download/vX/<asset>`; every
// other request is a 404.
export function serveAssets(directory: string, hostname: string, port: number): ServedAssets {
  const server = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const name = path.split("/").pop() ?? "";
      if (!SERVED_PATH_PATTERN.test(path) || !ASSET_NAME_PATTERN.test(name)) {
        return new Response("not found", { status: 404 });
      }
      const file = Bun.file(join(directory, name));
      if (!(await file.exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(file, { headers: { "content-type": "application/gzip" } });
    },
  });
  return {
    url: `http://${hostname}:${server.port}`,
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}

async function assertPacked(directory: string, pin: CoreSdkPin): Promise<void> {
  for (const sdkPackage of SDK_PACKAGES) {
    const name = assetName(sdkPackage, pin.sdkVersion);
    try {
      await access(join(directory, name));
    } catch {
      throw new Error(`${join(directory, name)} is missing; run \`bun run core-sdk:pack\` first`);
    }
  }
}

function runCommand(command: readonly string[]): Promise<number> {
  const [program, ...args] = command;
  if (program === undefined) {
    return Promise.resolve(0);
  }
  return new Promise((resolveStatus, reject) => {
    const child = spawn(program, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolveStatus(code ?? (signal === null ? 1 : 128));
    });
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--run");
  const own = separator === -1 ? args : args.slice(0, separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);
  let directory = DEFAULT_DIR;
  let pinPath: string | undefined;
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] === "--dir" && own[index + 1] !== undefined) {
      directory = resolve(own[index + 1] as string);
      index += 1;
    } else if (own[index] === "--pin" && own[index + 1] !== undefined) {
      pinPath = resolve(own[index + 1] as string);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${String(own[index])}`);
    }
  }
  const pin = pinPath === undefined ? loadPin() : loadPin(pinPath);
  const address = localServeAddress(pin);
  if (address === undefined) {
    process.stdout.write(`core-sdk.json names a core release (${pin.assetBaseUrl}); nothing to serve\n`);
    return runCommand(command);
  }
  await assertPacked(directory, pin);
  const served = serveAssets(directory, address.hostname, address.port);
  process.stdout.write(`serving ${directory} at ${served.url}${new URL(pin.assetBaseUrl).pathname}\n`);
  if (command.length === 0) {
    await new Promise<void>((resolveStop) => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
    await served.stop();
    return 0;
  }
  try {
    return await runCommand(command);
  } finally {
    await served.stop();
  }
}

if (import.meta.main) {
  main().then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      process.stderr.write(`serve-core-sdk: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
