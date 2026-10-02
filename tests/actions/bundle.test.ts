import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A compiled binary has no prompts/ directory beside it; the templates must be in the bundle.
test("the bundled program contains every prompt template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pohunek-work-bundle-"));
  try {
    const outfile = join(dir, "main.js");
    const build = Bun.spawnSync(["bun", "build", "src/main.ts", "--target", "bun", "--outfile", outfile], {
      cwd: new URL("../..", import.meta.url).pathname,
    });
    expect(build.exitCode).toBe(0);
    const bundle = await readFile(outfile, "utf8");
    for (const marker of [
      "You are working on Linear issue",
      "You are babysitting pull request",
      "You are fixing the failing CI checks",
      "You are resolving the merge conflict",
      "You are reviewing pull request",
    ]) {
      expect(bundle).toContain(marker);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
