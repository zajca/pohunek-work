// The web workspace's pin of the core TypeScript SDK (`@pohunek/protocol`,
// `@pohunek/sdk`, `@pohunek/testkit`).
//
// `web/core-sdk.json` is the single source. It names the core commit the SDK
// tarballs are built from and the location they are downloaded from:
//
//   coreRepository  the core GitHub repository
//   coreRev         the 40-digit core commit; CI builds the real daemon, worker
//                   and CLI from it, and it must equal the revision in
//                   `native/Cargo.toml` (`packaging/core-pin` checks both)
//   sdkVersion      the version stamped into the three tarballs
//   assetBaseUrl    where `vSDKVERSION/pohunek-ts-<package>-SDKVERSION.tgz` is
//                   served: a core release
//                   (`https://github.com/<owner>/<repo>/releases/download`) or,
//                   before the core release exists, the loopback server of
//                   `serve-core-sdk.ts` (`http://127.0.0.1:<port>/releases/download`)
//
// `web/package.json` carries the resulting URLs in its `catalog`, and
// `sync-core-sdk.ts` rewrites or verifies them from this file.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PIN_PATH = join(WEB_ROOT, "core-sdk.json");
export const PACKAGE_JSON_PATH = join(WEB_ROOT, "package.json");
// Untracked working area: the core checkout, the packed tarballs and the
// core binaries live below it.
export const WORK_DIR = join(WEB_ROOT, ".core-sdk");

export const SDK_PACKAGES = ["protocol", "sdk", "testkit"] as const;
export type SdkPackage = (typeof SDK_PACKAGES)[number];

const SCOPE = "@pohunek/";
const ASSET_PREFIX = "pohunek-ts-";
const ASSET_SUFFIX = ".tgz";
const RELEASE_DOWNLOAD_PATH = "/releases/download";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u;
const GITHUB_REPOSITORY_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/u;
const LOOPBACK_HOST = "127.0.0.1";
const PIN_KEYS = ["coreRepository", "coreRev", "sdkVersion", "assetBaseUrl"] as const;

export interface CoreSdkPin {
  readonly coreRepository: string;
  readonly coreRev: string;
  readonly sdkVersion: string;
  readonly assetBaseUrl: string;
}

export interface ServeAddress {
  readonly hostname: string;
  readonly port: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositorySlug(url: string): string | undefined {
  return GITHUB_REPOSITORY_PATTERN.exec(url)?.[1];
}

function parseAssetBase(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}: assetBaseUrl is not an absolute URL: ${value}`);
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new Error(`${label}: assetBaseUrl must not carry credentials, a query or a fragment`);
  }
  return url;
}

// Validates the pin file's content. `label` names the file in error messages.
export function parsePin(text: string, label: string): CoreSdkPin {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) {
    throw new Error(`${label}: must be a JSON object`);
  }
  for (const key of Object.keys(raw)) {
    if (!(PIN_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${label}: unknown key ${key}`);
    }
  }
  const field = (key: (typeof PIN_KEYS)[number]): string => {
    const value = raw[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(`${label}: ${key} must be a non-empty string`);
    }
    return value;
  };
  const pin: CoreSdkPin = {
    coreRepository: field("coreRepository"),
    coreRev: field("coreRev"),
    sdkVersion: field("sdkVersion"),
    assetBaseUrl: field("assetBaseUrl"),
  };
  const slug = repositorySlug(pin.coreRepository);
  if (slug === undefined) {
    throw new Error(`${label}: coreRepository must be https://github.com/<owner>/<repo>: ${pin.coreRepository}`);
  }
  if (!COMMIT_PATTERN.test(pin.coreRev)) {
    throw new Error(`${label}: coreRev must be a 40-digit lowercase commit: ${pin.coreRev}`);
  }
  if (!VERSION_PATTERN.test(pin.sdkVersion)) {
    throw new Error(`${label}: sdkVersion must be a semantic version without a leading "v": ${pin.sdkVersion}`);
  }
  const base = parseAssetBase(pin.assetBaseUrl, label);
  if (base.protocol === "https:") {
    if (base.host !== "github.com" || base.pathname !== `/${slug}${RELEASE_DOWNLOAD_PATH}`) {
      throw new Error(`${label}: an https assetBaseUrl must be the release download URL of ${pin.coreRepository}`);
    }
  } else if (base.protocol === "http:") {
    if (base.hostname !== LOOPBACK_HOST || base.port === "" || base.pathname !== RELEASE_DOWNLOAD_PATH) {
      throw new Error(
        `${label}: an http assetBaseUrl must be http://${LOOPBACK_HOST}:<port>${RELEASE_DOWNLOAD_PATH}`,
      );
    }
  } else {
    throw new Error(`${label}: assetBaseUrl must use https or http: ${pin.assetBaseUrl}`);
  }
  return pin;
}

export function loadPin(path: string = PIN_PATH): CoreSdkPin {
  return parsePin(readFileSync(path, "utf8"), path);
}

// The directory URL every tarball of the pin is served from.
export function releaseDirectoryUrl(pin: CoreSdkPin): string {
  return `${pin.assetBaseUrl}/v${pin.sdkVersion}`;
}

export function assetName(sdkPackage: SdkPackage, version: string): string {
  return `${ASSET_PREFIX}${sdkPackage}-${version}${ASSET_SUFFIX}`;
}

export function assetUrl(pin: CoreSdkPin, sdkPackage: SdkPackage): string {
  return `${releaseDirectoryUrl(pin)}/${assetName(sdkPackage, pin.sdkVersion)}`;
}

// The `catalog` entries `web/package.json` must carry for the pin.
export function catalogFor(pin: CoreSdkPin): Record<string, string> {
  const catalog: Record<string, string> = {};
  for (const sdkPackage of SDK_PACKAGES) {
    catalog[`${SCOPE}${sdkPackage}`] = assetUrl(pin, sdkPackage);
  }
  return catalog;
}

// The loopback address the pin's asset base names, or undefined when the
// tarballs come from a core release.
export function localServeAddress(pin: CoreSdkPin): ServeAddress | undefined {
  const base = new URL(pin.assetBaseUrl);
  if (base.protocol !== "http:") {
    return undefined;
  }
  return { hostname: base.hostname, port: Number(base.port) };
}

export interface CatalogSyncResult {
  readonly changed: boolean;
  readonly text: string;
}

// Returns `package.json` text whose `catalog` holds exactly the pin's URLs.
// Other keys keep their order; a missing `catalog` is placed after `workspaces`.
export function syncCatalogText(packageJsonText: string, pin: CoreSdkPin): CatalogSyncResult {
  const manifest: unknown = JSON.parse(packageJsonText);
  if (!isRecord(manifest)) {
    throw new Error("package.json must be a JSON object");
  }
  const catalog = catalogFor(pin);
  const current = manifest["catalog"];
  const unchanged =
    isRecord(current) &&
    Object.keys(current).length === Object.keys(catalog).length &&
    Object.entries(catalog).every(([name, url]) => current[name] === url);
  if (unchanged) {
    return { changed: false, text: packageJsonText };
  }
  const next: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "catalog") {
      continue;
    }
    next[key] = value;
    if (key === "workspaces") {
      next["catalog"] = catalog;
      placed = true;
    }
  }
  if (!placed) {
    next["catalog"] = catalog;
  }
  return { changed: true, text: `${JSON.stringify(next, null, 2)}\n` };
}

export function syncCatalogFile(path: string, pin: CoreSdkPin, write: boolean): CatalogSyncResult {
  const result = syncCatalogText(readFileSync(path, "utf8"), pin);
  if (result.changed && write) {
    writeFileSync(path, result.text);
  }
  return result;
}
