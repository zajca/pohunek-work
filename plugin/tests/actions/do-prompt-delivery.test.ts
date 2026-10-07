import { expect, test } from "bun:test";
import { runDo } from "../../src/commands/do.ts";
import type { WaitedSession } from "../../src/sources/pohunek.ts";
import { issue, session } from "../rules/builders.ts";
import { baseConfig, expectRefusal, fail, ok, options, refusal, setup } from "./harness.ts";

const waited = (reason: WaitedSession["reason"], state: string, activity: string | null) => () =>
  ok("pohunek", { reason, session: session({ id: "s-new", state, activity }) });

test("a confirmed run waits once for the new session to work, with the configured budget", async () => {
  const { deps, waits } = setup({ issues: ok("linear", [issue()]) });
  await runDo(baseConfig, options(), deps);
  const { promptDeliveryTimeoutMs, launchKillMarginMs } = baseConfig.global.actions;
  expect(waits).toEqual([
    { sessionId: "s-new", timeoutMs: promptDeliveryTimeoutMs, execTimeoutMs: promptDeliveryTimeoutMs + launchKillMarginMs },
  ]);
});

test("a session that stays idle is launch_unverified and names the screen, not a resend", async () => {
  const { deps } = setup({ issues: ok("linear", [issue()]), wait: waited("timeout", "running", "idle") });
  const error = await refusal(runDo(baseConfig, options(), deps));
  expect(error.code).toBe("launch_unverified");
  expect(error.message).toContain("s-new");
  expect(error.message).toContain("stayed idle");
  expect(error.message).toContain("pohunek session screen s-new --json");
  expect(error.message).toContain("do not resend the prompt");
  expect(error.message).toContain("pohunek session rm s-new");
});

test("a session that ended during the wait is launch_unverified with its state", async () => {
  const { deps } = setup({ issues: ok("linear", [issue()]), wait: waited("timeout", "stopped", null) });
  await expectRefusal(runDo(baseConfig, options(), deps), "launch_unverified", "it ended (state stopped)");
});

test("a failed wait is launch_unverified with the failure code and message", async () => {
  const { deps } = setup({ issues: ok("linear", [issue()]), wait: () => fail("pohunek", "unavailable", "pohunek error session_not_found (class state)") });
  await expectRefusal(runDo(baseConfig, options(), deps), "launch_unverified", "unavailable: pohunek error session_not_found");
});

test("no wait happens when the launch fails or its metadata differs", async () => {
  const failed = setup({ issues: ok("linear", [issue()]), launch: () => fail("pohunek", "unavailable", "boom") });
  await expectRefusal(runDo(baseConfig, options(), failed.deps), "launch_failed");
  const mismatched = setup({ issues: ok("linear", [issue()]), launch: () => ok("pohunek", session({ id: "s-x" })) });
  await expectRefusal(runDo(baseConfig, options(), mismatched.deps), "launch_unverified", "metadata");
  expect([failed.waits.length, mismatched.waits.length]).toEqual([0, 0]);
});
