import { describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { createBinding, FdLockError, tryLockExclusive, type FfiModule, type FlockBinding } from "../src/fd-lock";

const FLOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;
const FAKE_DESCRIPTOR = 42;
const UNKNOWN_ERRNO = 99_999;
const FAKE_POINTER = { pointer: true };

function fakeBinding(result: number, errno: number): FlockBinding & { readonly calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls,
    flock(descriptor, operation): number {
      calls.push([descriptor, operation]);
      return result;
    },
    errno: () => errno,
  };
}

describe("tryLockExclusive with a fake binding", () => {
  test("flock success reports locked and requests an exclusive non-blocking lock", () => {
    const binding = fakeBinding(0, 0);
    expect(tryLockExclusive(FAKE_DESCRIPTOR, binding)).toBe("locked");
    expect(binding.calls).toEqual([[FAKE_DESCRIPTOR, FLOCK_EXCLUSIVE_NONBLOCKING]]);
  });

  test("EWOULDBLOCK reports held", () => {
    expect(tryLockExclusive(FAKE_DESCRIPTOR, fakeBinding(-1, osConstants.errno.EWOULDBLOCK))).toBe("held");
  });

  test("another errno is an FdLockError naming it", () => {
    const error = failure(() => tryLockExclusive(FAKE_DESCRIPTOR, fakeBinding(-1, osConstants.errno.EBADF)));
    expect(error).toBeInstanceOf(FdLockError);
    expect(error.message.includes("EBADF")).toBe(true);
  });

  test("an errno without a name is reported by number", () => {
    const error = failure(() => tryLockExclusive(FAKE_DESCRIPTOR, fakeBinding(-1, UNKNOWN_ERRNO)));
    expect(error).toBeInstanceOf(FdLockError);
    expect(error.message.includes(`errno ${String(UNKNOWN_ERRNO)}`)).toBe(true);
  });
});

describe("createBinding", () => {
  test("a platform without a known libc is refused", () => {
    const error = failure(() => createBinding("win32", () => fakeFfi().ffi));
    expect(error).toBeInstanceOf(FdLockError);
    expect(error.message.includes("win32")).toBe(true);
  });

  test("a failing ffi load is an FdLockError carrying the cause", () => {
    const cause = new Error("no bun:ffi here");
    const error = failure(() =>
      createBinding("linux", () => {
        throw cause;
      }),
    );
    expect(error).toBeInstanceOf(FdLockError);
    expect(error.cause).toBe(cause);
    expect(error.message.includes("no bun:ffi here")).toBe(true);
  });

  test("a failing dlopen is an FdLockError carrying the cause", () => {
    const cause = new Error("library not found");
    const { ffi } = fakeFfi({
      dlopen: () => {
        throw cause;
      },
    });
    const error = failure(() => createBinding("linux", () => ffi));
    expect(error).toBeInstanceOf(FdLockError);
    expect(error.cause).toBe(cause);
  });

  test("a library missing a symbol is an FdLockError", () => {
    for (const missing of ["flock", "__errno_location"]) {
      const { ffi } = fakeFfi({ omit: missing });
      const error = failure(() => createBinding("linux", () => ffi));
      expect(error).toBeInstanceOf(FdLockError);
      expect(error.message.includes("lacks")).toBe(true);
    }
  });

  test("linux resolves flock and __errno_location from libc.so.6", () => {
    const fake = fakeFfi({ flockResult: -1, errnoValue: osConstants.errno.EWOULDBLOCK });
    const binding = createBinding("linux", () => fake.ffi);
    expect(fake.opened).toEqual([{ path: "libc.so.6", symbols: ["flock", "__errno_location"] }]);
    expect(tryLockExclusive(FAKE_DESCRIPTOR, binding)).toBe("held");
    expect(fake.flockCalls).toEqual([[FAKE_DESCRIPTOR, FLOCK_EXCLUSIVE_NONBLOCKING]]);
    expect(fake.readPointers).toEqual([FAKE_POINTER]);
  });

  test("darwin resolves flock and __error from libSystem", () => {
    const fake = fakeFfi({ flockResult: 0 });
    const binding = createBinding("darwin", () => fake.ffi);
    expect(fake.opened).toEqual([{ path: "/usr/lib/libSystem.B.dylib", symbols: ["flock", "__error"] }]);
    expect(tryLockExclusive(FAKE_DESCRIPTOR, binding)).toBe("locked");
    expect(fake.readPointers).toEqual([]);
  });

  test("a bigint return from the native call is normalized", () => {
    const fake = fakeFfi({ flockResult: 0n });
    expect(tryLockExclusive(FAKE_DESCRIPTOR, createBinding("linux", () => fake.ffi))).toBe("locked");
  });
});

describe("tryLockExclusive with the system binding", () => {
  test("a second descriptor of the same file is held until the first is closed", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pohunek-fd-lock-")));
    const descriptors: number[] = [];
    try {
      const path = join(root, "lock");
      await writeFile(path, "");
      const open = (): number => {
        const descriptor = openSync(path, "r");
        descriptors.push(descriptor);
        return descriptor;
      };
      const first = open();
      expect(tryLockExclusive(first)).toBe("locked");
      const second = open();
      expect(tryLockExclusive(second)).toBe("held");

      closeSync(first);
      descriptors.splice(descriptors.indexOf(first), 1);
      const third = open();
      expect(tryLockExclusive(third)).toBe("locked");
      expect(tryLockExclusive(second)).toBe("held");
    } finally {
      for (const descriptor of descriptors) {
        closeSync(descriptor);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an invalid descriptor is an FdLockError naming EBADF", () => {
    const error = failure(() => tryLockExclusive(-1));
    expect(error).toBeInstanceOf(FdLockError);
    expect(error.message.includes("EBADF")).toBe(true);
  });
});

interface FakeFfi {
  readonly ffi: FfiModule;
  readonly opened: { path: string; symbols: string[] }[];
  readonly flockCalls: number[][];
  readonly readPointers: unknown[];
}

function fakeFfi(
  options: {
    readonly flockResult?: number | bigint;
    readonly errnoValue?: number;
    readonly omit?: string;
    readonly dlopen?: FfiModule["dlopen"];
  } = {},
): FakeFfi {
  const opened: { path: string; symbols: string[] }[] = [];
  const flockCalls: number[][] = [];
  const readPointers: unknown[] = [];
  const ffi: FfiModule = {
    dlopen:
      options.dlopen ??
      ((path, symbols) => {
        const names = Object.keys(symbols);
        opened.push({ path, symbols: names });
        const table: Record<string, (...args: number[]) => unknown> = {};
        for (const name of names) {
          if (name === options.omit) continue;
          table[name] =
            name === "flock"
              ? (...args): unknown => {
                  flockCalls.push(args);
                  return options.flockResult ?? 0;
                }
              : (): unknown => FAKE_POINTER;
        }
        return { symbols: table };
      }),
    read: {
      i32(pointer): number {
        readPointers.push(pointer);
        return options.errnoValue ?? 0;
      },
    },
  };
  return { ffi, opened, flockCalls, readPointers };
}

function failure(action: () => unknown): Error {
  let caught: unknown;
  try {
    action();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}
