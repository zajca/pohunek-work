// Downloads the pohunek core daemon archive pinned in core-release.json for this
// platform, verifies its sha256 and prints the variable the real-daemon tests read.
//
// usage: eval "$(bun scripts/core-binaries.ts)"
//
// Only pohunekd, pohunek-sessiond and pohunek are extracted, into
// .core-binaries/<release>/<archive name without .tar.gz>/. That directory is
// renamed into place only after the digest matched and holds a marker with the
// digest, so an install whose marker matches the pin is reused. Progress goes to
// stderr so stdout stays evaluable.
import { createHash } from "node:crypto";
import { access, constants, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Names the directory holding the core binaries; the real-daemon tests read it. */
export const CORE_DIR_ENV = "POHUNEK_TEST_CORE_DIR";
export const CORE_BINARIES = ["pohunekd", "pohunek-sessiond", "pohunek"] as const;

const PLUGIN_DIR = resolve(import.meta.dir, "..");
const PIN_FILE = join(PLUGIN_DIR, "core-release.json");
const INSTALL_ROOT = join(PLUGIN_DIR, ".core-binaries");
const MARKER_FILE = "VERIFIED_SHA256";
const ARCHIVE_SUFFIX = ".tar.gz";
/** Upper bound for downloading one archive (about 20 MB). */
const DOWNLOAD_TIMEOUT_MS = 300_000;
const FAILURE_STATUS = 1;

interface PinnedTarget {
  readonly platform: string;
  readonly arch: string;
  readonly archive: string;
  readonly sha256: string;
}

interface CorePin {
  readonly release: string;
  readonly assetBaseUrl: string;
  readonly targets: readonly PinnedTarget[];
}

class PinError extends Error {}

function field(object: Record<string, unknown>, key: string, pattern: RegExp, where: string): string {
  const value = object[key];
  if (typeof value !== "string" || !pattern.test(value)) throw new PinError(`${PIN_FILE}: ${where}.${key} must match ${String(pattern)}`);
  return value;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PinError(`${PIN_FILE}: ${where} must be an object`);
  return value as Record<string, unknown>;
}

async function loadPin(): Promise<CorePin> {
  const pin = asRecord(JSON.parse(await readFile(PIN_FILE, "utf8")) as unknown, "$");
  const targets = pin["targets"];
  if (!Array.isArray(targets) || targets.length === 0) throw new PinError(`${PIN_FILE}: $.targets must be a non-empty array`);
  return {
    release: field(pin, "release", /^v[0-9]+\.[0-9]+\.[0-9]+$/, "$"),
    assetBaseUrl: field(pin, "assetBaseUrl", /^https:\/\/[^\s]+[^/\s]$/, "$"),
    targets: targets.map((entry: unknown, index) => {
      const where = `$.targets[${String(index)}]`;
      const target = asRecord(entry, where);
      return {
        platform: field(target, "platform", /^[a-z0-9]+$/, where),
        arch: field(target, "arch", /^[a-z0-9]+$/, where),
        archive: field(target, "archive", /^[A-Za-z0-9._-]+\.tar\.gz$/, where),
        sha256: field(target, "sha256", /^[0-9a-f]{64}$/, where),
      };
    }),
  };
}

function isMissingOrNotExecutable(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES");
}

/** Whether `dir` holds every binary, executable, with the marker of `sha256`. */
async function isInstalled(dir: string, sha256: string): Promise<boolean> {
  try {
    const marker = (await readFile(join(dir, MARKER_FILE), "utf8")).trim();
    if (marker !== sha256) return false;
    await Promise.all(CORE_BINARIES.map((name) => access(join(dir, name), constants.X_OK)));
    return true;
  } catch (error) {
    if (isMissingOrNotExecutable(error)) return false;
    throw error;
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download of ${url} failed with HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function extract(archive: string, into: string, members: readonly string[]): Promise<void> {
  const tar = Bun.spawn(["tar", "-xzf", archive, "-C", into, ...members], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  const status = await tar.exited;
  if (status !== 0) throw new Error(`tar exited with status ${String(status)} while extracting ${archive}`);
}

async function install(pin: CorePin, target: PinnedTarget, dir: string): Promise<void> {
  const releaseDir = join(INSTALL_ROOT, pin.release);
  await mkdir(releaseDir, { recursive: true });
  const staging = await mkdtemp(join(releaseDir, ".staging-"));
  try {
    const url = `${pin.assetBaseUrl}/${pin.release}/${target.archive}`;
    console.error(`core-binaries: downloading ${url}`);
    const bytes = await download(url);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== target.sha256) throw new Error(`sha256 of ${target.archive} is ${digest}, the pin requires ${target.sha256}; nothing was extracted`);
    const archivePath = join(staging, target.archive);
    await writeFile(archivePath, bytes);
    const stem = target.archive.slice(0, -ARCHIVE_SUFFIX.length);
    await extract(archivePath, staging, CORE_BINARIES.map((name) => `${stem}/${name}`));
    const extracted = join(staging, stem);
    await writeFile(join(extracted, MARKER_FILE), `${target.sha256}\n`);
    if (!(await isInstalled(extracted, target.sha256))) throw new Error(`${target.archive} does not contain every binary: ${CORE_BINARIES.join(", ")}`);
    // A directory without a matching marker is a stale or foreign install.
    await rm(dir, { recursive: true, force: true });
    try {
      await rename(extracted, dir);
    } catch (error) {
      // A concurrent run may have renamed its verified copy into place first.
      if (!(await isInstalled(dir, target.sha256))) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Single-quoted so the value survives `eval` unchanged.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main(): Promise<void> {
  const pin = await loadPin();
  const target = pin.targets.find((t) => t.platform === process.platform && t.arch === process.arch);
  if (target === undefined) {
    const pinned = pin.targets.map((t) => `${t.platform}-${t.arch}`).join(", ");
    throw new Error(`core ${pin.release} has no daemon archive pinned for ${process.platform}-${process.arch} (pinned: ${pinned})`);
  }
  const dir = join(INSTALL_ROOT, pin.release, target.archive.slice(0, -ARCHIVE_SUFFIX.length));
  if (await isInstalled(dir, target.sha256)) {
    console.error(`core-binaries: reusing ${dir}`);
  } else {
    await install(pin, target, dir);
    console.error(`core-binaries: installed ${dir}`);
  }
  console.log(`export ${CORE_DIR_ENV}=${shellQuote(dir)}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`core-binaries: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(FAILURE_STATUS);
  }
}
