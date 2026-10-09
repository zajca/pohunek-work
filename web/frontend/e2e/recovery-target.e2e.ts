import { connectTcp } from "@pohunek/sdk";
import { expect, test } from "./fixtures";
import {
  FIXTURE_LOCAL_HOST,
  FIXTURE_LOCAL_NATIVE_ACTIVITY,
  FIXTURE_LOCAL_RECOVERY_ID,
  FIXTURE_LOCAL_SESSION_ID,
} from "../../scripts/fixture-stack";

const STALE_RECOVERY_ID = "fixture-obsolete-conversation";

test("fork confirms the inspected conversation when the browser list is stale", async ({ page, stack }) => {
  let staleListInjected = false;
  await page.routeWebSocket("**/*", (socket): void => {
    const server = socket.connectToServer();
    server.onMessage((message): void => {
      if (typeof message === "string") {
        const response = JSON.parse(message) as unknown;
        if (typeof response === "object" && response !== null && "ok" in response && Array.isArray(response.ok)) {
          const sessions = response.ok as unknown[];
          const localSession = sessions.find((entry): boolean =>
            typeof entry === "object" && entry !== null && "id" in entry && entry.id === FIXTURE_LOCAL_SESSION_ID);
          if (localSession !== undefined) {
            // Keep the daemon's seeded recovery target intact; delay only the browser's list view.
            (localSession as { native_session_id: string }).native_session_id = STALE_RECOVERY_ID;
            staleListInjected = true;
            socket.send(JSON.stringify(response));
            return;
          }
        }
      }
      socket.send(message);
    });
  });

  await page.goto(stack.backend.url);
  const row = page.locator(`[data-testid="session-row"][data-host="${FIXTURE_LOCAL_HOST}"][data-session-id="${FIXTURE_LOCAL_SESSION_ID}"]`);
  await expect(row).toContainText(STALE_RECOVERY_ID);
  expect(staleListInjected).toBe(true);

  const address = stack.local.tcpAddress;
  if (address === undefined) throw new Error("fixture local daemon did not expose a TCP address");
  const client = await connectTcp(FIXTURE_LOCAL_HOST, address);
  try {
    expect((await client.call("session.inspect", FIXTURE_LOCAL_SESSION_ID)).native_session_id).toBe(FIXTURE_LOCAL_RECOVERY_ID);
    const countBefore = (await client.call("session.list", null)).length;

    await row.click();
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    await page.getByRole("dialog", { name: "Fork session" }).getByRole("button", { name: "Save" }).click();
    const confirmation = page.getByRole("dialog", { name: "Confirm fork target" });
    await expect(confirmation).toContainText(FIXTURE_LOCAL_RECOVERY_ID);
    await expect(confirmation).toContainText(FIXTURE_LOCAL_NATIVE_ACTIVITY);
    await expect(confirmation).not.toContainText(STALE_RECOVERY_ID);
    expect((await client.call("session.list", null)).length).toBe(countBefore);

    await confirmation.getByRole("button", { name: "Cancel" }).click();
    expect((await client.call("session.list", null)).length).toBe(countBefore);
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    await page.getByRole("dialog", { name: "Fork session" }).getByRole("button", { name: "Save" }).click();
    const secondConfirmation = page.getByRole("dialog", { name: "Confirm fork target" });
    await expect(secondConfirmation).toContainText(FIXTURE_LOCAL_RECOVERY_ID);
    await secondConfirmation.getByRole("button", { name: "Fork session" }).click();
    await expect.poll(async () => (await client.call("session.list", null)).length).toBe(countBefore + 1);
  } finally {
    await client.close();
  }
});

test("fork requires a new confirmation when the inspected target changes", async ({ page, stack }) => {
  let delayOneInspect = false;
  await page.routeWebSocket("**/*", (socket): void => {
    const server = socket.connectToServer();
    server.onMessage((message): void => {
      if (delayOneInspect && typeof message === "string") {
        const response = JSON.parse(message) as unknown;
        if (typeof response === "object" && response !== null && "ok" in response
          && typeof response.ok === "object" && response.ok !== null
          && "id" in response.ok && response.ok.id === FIXTURE_LOCAL_SESSION_ID) {
          // Model an inspect response captured just before a native target switch.
          (response.ok as { native_session_id: string }).native_session_id = STALE_RECOVERY_ID;
          delayOneInspect = false;
          socket.send(JSON.stringify(response));
          return;
        }
      }
      socket.send(message);
    });
  });

  await page.goto(stack.backend.url);
  const address = stack.local.tcpAddress;
  if (address === undefined) throw new Error("fixture local daemon did not expose a TCP address");
  const client = await connectTcp(FIXTURE_LOCAL_HOST, address);
  try {
    const countBefore = (await client.call("session.list", null)).length;
    await page.locator(`[data-testid="session-row"][data-host="${FIXTURE_LOCAL_HOST}"][data-session-id="${FIXTURE_LOCAL_SESSION_ID}"]`).click();
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    delayOneInspect = true;
    await page.getByRole("dialog", { name: "Fork session" }).getByRole("button", { name: "Save" }).click();
    const confirmation = page.getByRole("dialog", { name: "Confirm fork target" });
    await expect(confirmation).toContainText(STALE_RECOVERY_ID);
    await expect(confirmation).toContainText(FIXTURE_LOCAL_NATIVE_ACTIVITY);
    expect(delayOneInspect).toBe(false);
    expect((await client.call("session.list", null)).length).toBe(countBefore);

    await confirmation.getByRole("button", { name: "Fork session" }).click();
    await expect(confirmation).toContainText(FIXTURE_LOCAL_RECOVERY_ID);
    await expect(confirmation).not.toContainText(STALE_RECOVERY_ID);
    expect((await client.call("session.list", null)).length).toBe(countBefore);

    await confirmation.getByRole("button", { name: "Fork session" }).click();
    await expect.poll(async () => (await client.call("session.list", null)).length).toBe(countBefore + 1);
  } finally {
    await client.close();
  }
});
