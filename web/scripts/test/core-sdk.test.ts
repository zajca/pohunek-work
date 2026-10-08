import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetUrl, loadPin, type CoreSdkPin } from "../core-sdk";
import { serveAssets } from "../serve-core-sdk";

const LOCAL: CoreSdkPin = {
  coreRepository: "https://github.com/zajca/pohunek",
  coreRev: "0123456789abcdef0123456789abcdef01234567",
  sdkVersion: "0.0.0-core.0123456",
  assetBaseUrl: "http://127.0.0.1:47321/releases/download",
};
const SERVE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "serve-core-sdk.ts");
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// A pin that names the loopback asset server, whatever the repository pin is, so the
// serve script is exercised before and after the cutover to a release URL.
async function loopbackPinFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pohunek-pin-"));
  roots.push(root);
  const path = join(root, "core-sdk.json");
  await writeFile(path, JSON.stringify(LOCAL));
  return path;
}

async function assetDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pohunek-serve-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "pohunek-ts-sdk-1.2.3.tgz"), "tarball-bytes");
  await writeFile(join(root, "secret.txt"), "not an asset");
  return root;
}

describe("asset server", () => {
  test("serves an asset under the release path and nothing else", async () => {
    const served = serveAssets(await assetDirectory(), "127.0.0.1", 0);
    try {
      const ok = await fetch(`${served.url}/releases/download/v1.2.3/pohunek-ts-sdk-1.2.3.tgz`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("tarball-bytes");
      for (const path of [
        "/releases/download/v1.2.3/pohunek-ts-sdk-9.9.9.tgz",
        "/releases/download/v1.2.3/secret.txt",
        "/pohunek-ts-sdk-1.2.3.tgz",
        "/releases/download/v1.2.3/..%2Fsecret.txt",
      ]) {
        expect((await fetch(`${served.url}${path}`)).status).toBe(404);
      }
    } finally {
      await served.stop();
    }
  });

  test("the command form serves while the command runs and returns its status", async () => {
    const directory = await assetDirectory();
    const pinPath = await loopbackPinFile();
    const pin = loadPin(pinPath);
    for (const sdkPackage of ["protocol", "sdk", "testkit"]) {
      await writeFile(join(directory, `pohunek-ts-${sdkPackage}-${pin.sdkVersion}.tgz`), sdkPackage);
    }
    const probe = `const r = await fetch(${JSON.stringify(assetUrl(pin, "sdk"))}); process.exit(r.status === 200 ? 7 : 1);`;
    const child = Bun.spawn([process.execPath, SERVE_SCRIPT, "--dir", directory, "--pin", pinPath, "--run", process.execPath, "-e", probe], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(7);
  });

  test("a missing tarball is reported before serving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pohunek-serve-empty-"));
    roots.push(directory);
    const pinPath = await loopbackPinFile();
    const child = Bun.spawn([process.execPath, SERVE_SCRIPT, "--dir", directory, "--pin", pinPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("is missing; run `bun run core-sdk:pack` first");
  });
});
