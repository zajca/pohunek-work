import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";

/** `flock(2)` operations; the values are identical on Linux and macOS. */
const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;

/** `bun:ffi` surface the lock uses; the module is loaded only when a lock is taken. */
export interface FfiModule {
  dlopen(path: string, symbols: Record<string, { args: readonly string[]; returns: string }>): {
    readonly symbols: Record<string, (...args: number[]) => unknown>;
  };
  readonly read: { i32(pointer: unknown): number };
}

/** The two libc calls the lock needs, already resolved. */
export interface FlockBinding {
  /** `flock(descriptor, operation)`; `0` on success, `-1` on failure. */
  flock(descriptor: number, operation: number): number;
  /** `errno` of the calling thread right after a failed `flock`. */
  errno(): number;
}

interface LibcTarget {
  readonly library: string;
  readonly errnoSymbol: string;
}

/**
 * Release targets are glibc (`bun-linux-x64-baseline`) and macOS
 * (`bun-darwin-arm64`). The macOS path is absolute: its libraries live in the
 * dyld shared cache and resolve there without a file on disk.
 */
const LIBC_TARGETS: Readonly<Partial<Record<NodeJS.Platform, LibcTarget>>> = {
  linux: { library: "libc.so.6", errnoSymbol: "__errno_location" },
  darwin: { library: "/usr/lib/libSystem.B.dylib", errnoSymbol: "__error" },
};

export class FdLockError extends Error {
  public override readonly name = "FdLockError";
}

export type FdLockOutcome = "locked" | "held";

/**
 * Takes a non-blocking exclusive advisory lock (`flock`) on an open file.
 *
 * The lock belongs to the open file description, so it conflicts with another
 * description of the same file in this or any other process, and the kernel
 * drops it when the description is closed or the process dies. Returns `held`
 * when another description owns the lock and throws {@link FdLockError} for any
 * other failure, including a platform without a known libc.
 */
export function tryLockExclusive(descriptor: number, binding: FlockBinding = systemBinding()): FdLockOutcome {
  if (binding.flock(descriptor, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) === 0) {
    return "locked";
  }
  const errno = binding.errno();
  if (errno === osConstants.errno.EWOULDBLOCK) {
    return "held";
  }
  throw new FdLockError(`flock failed with ${errnoName(errno)}`);
}

/**
 * Resolves `flock` and the errno accessor of the platform libc through
 * `bun:ffi`, which Bun does not expose any other way. A runtime without
 * `bun:ffi` or a platform without a known libc throws {@link FdLockError}.
 */
export function createBinding(platform: NodeJS.Platform, loadFfi: () => FfiModule): FlockBinding {
  const target = LIBC_TARGETS[platform];
  if (target === undefined) {
    throw new FdLockError(`no libc binding for platform ${platform}`);
  }
  try {
    const ffi = loadFfi();
    const { symbols } = ffi.dlopen(target.library, {
      flock: { args: ["i32", "i32"], returns: "i32" },
      [target.errnoSymbol]: { args: [], returns: "ptr" },
    });
    const flock = symbols["flock"];
    const errnoLocation = symbols[target.errnoSymbol];
    if (flock === undefined || errnoLocation === undefined) {
      throw new FdLockError(`${target.library} lacks flock or ${target.errnoSymbol}`);
    }
    return {
      flock: (descriptor, operation) => Number(flock(descriptor, operation)),
      errno: () => ffi.read.i32(errnoLocation()),
    };
  } catch (error: unknown) {
    if (error instanceof FdLockError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new FdLockError(`cannot load flock from ${target.library}: ${detail}`, { cause: error });
  }
}

let cachedBinding: FlockBinding | undefined;

function systemBinding(): FlockBinding {
  cachedBinding ??= createBinding(process.platform, loadBunFfi);
  return cachedBinding;
}

function loadBunFfi(): FfiModule {
  // `bun:ffi` exists only under Bun, so the import stays out of the static
  // module graph that Node-based tooling loads.
  return createRequire(import.meta.url)("bun:ffi") as FfiModule;
}

function errnoName(errno: number): string {
  const entry = Object.entries(osConstants.errno).find(([, value]) => value === errno);
  return entry === undefined ? `errno ${String(errno)}` : entry[0];
}
