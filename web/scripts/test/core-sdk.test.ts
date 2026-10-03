import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_JSON_PATH,
  PIN_PATH,
  assetUrl,
  catalogFor,
  loadPin,
  localServeAddress,
  parsePin,
  releaseDirectoryUrl,
  syncCatalogText,
  type CoreSdkPin,
} from "../core-sdk";
import { serveAssets } from "../serve-core-sdk";

const REV = "0123456789abcdef0123456789abcdef01234567";
const LOCAL: CoreSdkPin = {
  coreRepository: "https://github.com/zajca/pohunek",
  coreRev: REV,
  sdkVersion: "0.0.0-core.0123456",
  assetBaseUrl: "http://127.0.0.1:47321/releases/download",
};
const RELEASE: CoreSdkPin = {
  ...LOCAL,
  sdkVersion: "1.2.3",
  assetBaseUrl: "https://github.com/zajca/pohunek/releases/download",
};
const SERVE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "serve-core-sdk.ts");
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function parse(overrides: Record<string, unknown>): CoreSdkPin {
  return parsePin(JSON.stringify({ ...LOCAL, ...overrides }), "pin");
}

describe("core SDK pin", () => {
  test("the repository's pin file is valid", () => {
    const pin = loadPin(PIN_PATH);
    expect(pin.coreRev).toMatch(/^[0-9a-f]{40}$/u);
  });

  test("both asset locations are accepted", () => {
    expect(parsePin(JSON.stringify(LOCAL), "pin")).toEqual(LOCAL);
    expect(parsePin(JSON.stringify(RELEASE), "pin")).toEqual(RELEASE);
  });

  test("a malformed pin is refused with the reason", () => {
    expect(() => parsePin("{", "pin")).toThrow("not valid JSON");
    expect(() => parsePin("[]", "pin")).toThrow("must be a JSON object");
    expect(() => parse({ extra: "x" })).toThrow("unknown key extra");
    expect(() => parse({ coreRev: "abc" })).toThrow("40-digit");
    expect(() => parse({ coreRev: 7 })).toThrow("coreRev must be a non-empty string");
    expect(() => parse({ sdkVersion: "v1.2.3" })).toThrow("semantic version");
    expect(() => parse({ coreRepository: "https://example.com/a/b" })).toThrow("coreRepository");
    expect(() => parse({ assetBaseUrl: "not a url" })).toThrow("not an absolute URL");
    expect(() => parse({ assetBaseUrl: "ftp://127.0.0.1:1/releases/download" })).toThrow("https or http");
    expect(() => parse({ assetBaseUrl: "http://127.0.0.1:47321/releases/download?x=1" })).toThrow("query");
    expect(() => parse({ assetBaseUrl: "http://10.0.0.1:47321/releases/download" })).toThrow("127.0.0.1");
    expect(() => parse({ assetBaseUrl: "http://127.0.0.1/releases/download" })).toThrow("<port>");
    expect(() => parse({ assetBaseUrl: "https://github.com/other/repo/releases/download" })).toThrow(
      "release download URL of https://github.com/zajca/pohunek",
    );
    expect(() => parse({ assetBaseUrl: "https://example.com/zajca/pohunek/releases/download" })).toThrow(
      "release download URL",
    );
  });

  test("URLs have the release download form", () => {
    expect(releaseDirectoryUrl(RELEASE)).toBe("https://github.com/zajca/pohunek/releases/download/v1.2.3");
    expect(assetUrl(RELEASE, "sdk")).toBe(
      "https://github.com/zajca/pohunek/releases/download/v1.2.3/pohunek-ts-sdk-1.2.3.tgz",
    );
    expect(catalogFor(LOCAL)).toEqual({
      "@pohunek/protocol":
        "http://127.0.0.1:47321/releases/download/v0.0.0-core.0123456/pohunek-ts-protocol-0.0.0-core.0123456.tgz",
      "@pohunek/sdk":
        "http://127.0.0.1:47321/releases/download/v0.0.0-core.0123456/pohunek-ts-sdk-0.0.0-core.0123456.tgz",
      "@pohunek/testkit":
        "http://127.0.0.1:47321/releases/download/v0.0.0-core.0123456/pohunek-ts-testkit-0.0.0-core.0123456.tgz",
    });
  });

  test("only a loopback base is served locally", () => {
    expect(localServeAddress(LOCAL)).toEqual({ hostname: "127.0.0.1", port: 47321 });
    expect(localServeAddress(RELEASE)).toBeUndefined();
  });
});

describe("package.json catalog", () => {
  test("the repository's package.json matches its pin", async () => {
    const text = await Bun.file(PACKAGE_JSON_PATH).text();
    expect(syncCatalogText(text, loadPin(PIN_PATH)).changed).toBe(false);
  });

  test("a stale or missing catalog is rewritten and keeps the other keys", () => {
    const stale = JSON.stringify({ name: "x", workspaces: ["a"], catalog: { "@pohunek/sdk": "old" }, scripts: {} });
    const synced = syncCatalogText(stale, RELEASE);
    expect(synced.changed).toBe(true);
    const manifest = JSON.parse(synced.text) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(["name", "workspaces", "catalog", "scripts"]);
    expect(manifest["catalog"]).toEqual(catalogFor(RELEASE));
    expect(syncCatalogText(synced.text, RELEASE).changed).toBe(false);
    const missing = JSON.parse(syncCatalogText(JSON.stringify({ name: "x" }), RELEASE).text) as Record<string, unknown>;
    expect(missing["catalog"]).toEqual(catalogFor(RELEASE));
  });

  test("an extra catalog entry counts as a mismatch", () => {
    const extra = JSON.stringify({ catalog: { ...catalogFor(RELEASE), "@pohunek/other": "x" } });
    expect(syncCatalogText(extra, RELEASE).changed).toBe(true);
  });
});

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
    const pin = loadPin(PIN_PATH);
    const address = localServeAddress(pin);
    if (address === undefined) {
      return;
    }
    for (const sdkPackage of ["protocol", "sdk", "testkit"]) {
      await writeFile(join(directory, `pohunek-ts-${sdkPackage}-${pin.sdkVersion}.tgz`), sdkPackage);
    }
    const probe = `const r = await fetch(${JSON.stringify(assetUrl(pin, "sdk"))}); process.exit(r.status === 200 ? 7 : 1);`;
    const child = Bun.spawn([process.execPath, SERVE_SCRIPT, "--dir", directory, "--run", process.execPath, "-e", probe], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(7);
  });

  test("a missing tarball is reported before serving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pohunek-serve-empty-"));
    roots.push(directory);
    const child = Bun.spawn([process.execPath, SERVE_SCRIPT, "--dir", directory], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("is missing; run `bun run core-sdk:pack` first");
  });
});
