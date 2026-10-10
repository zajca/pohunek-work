import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { expect, test as base } from "@playwright/test";
import {
  startFixtureStack,
  type FixtureStackHandle,
} from "../../scripts/fixture-stack";

const FRONTEND_DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
const PACKAGED_BACKEND_BIN_ENV = "POHUNEK_E2E_PACKAGED_BACKEND_BIN";
const PACKAGED_STATIC_DIR_ENV = "POHUNEK_E2E_PACKAGED_STATIC_DIR";

function packagedBackendPaths(): { executable: string; staticAssetsDir: string } | undefined {
  const executable = process.env[PACKAGED_BACKEND_BIN_ENV];
  const staticAssetsDir = process.env[PACKAGED_STATIC_DIR_ENV];
  if (executable === undefined && staticAssetsDir === undefined) {
    return undefined;
  }
  if (executable === undefined || staticAssetsDir === undefined) {
    throw new Error(`${PACKAGED_BACKEND_BIN_ENV} and ${PACKAGED_STATIC_DIR_ENV} must be set together`);
  }
  if (!isAbsolute(executable) || !isAbsolute(staticAssetsDir)) {
    throw new Error(`${PACKAGED_BACKEND_BIN_ENV} and ${PACKAGED_STATIC_DIR_ENV} must be absolute paths`);
  }
  return { executable, staticAssetsDir };
}

const PACKAGED_BACKEND = packagedBackendPaths();

interface FrontendFixtures {
  readonly stack: FixtureStackHandle;
}

export const test = base.extend<FrontendFixtures>({
  stack: async ({}, use): Promise<void> => {
    const stack = await startFixtureStack(PACKAGED_BACKEND === undefined
      ? { staticAssetsDir: FRONTEND_DIST_DIR }
      : { packagedBackend: PACKAGED_BACKEND });
    try {
      await use(stack);
    } finally {
      await stack.close();
    }
  },
});

export { expect };
