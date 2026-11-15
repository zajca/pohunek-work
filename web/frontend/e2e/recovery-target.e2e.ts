import { connectTcp } from "@pohunek/sdk";
import { expect, test } from "./fixtures";
import {
  FIXTURE_LOCAL_HOST,
  FIXTURE_LOCAL_NATIVE_ACTIVITY,
  FIXTURE_LOCAL_RECOVERY_ID,
  FIXTURE_LOCAL_STOPPED_SESSION_ID,
} from "../../scripts/fixture-stack";

const STALE_RECOVERY_ID = "fixture-obsolete-conversation";

test("recovery refuses ambiguous, empty, or mismatched inspect responses", async ({ page, stack }) => {
  type TamperMode = "both-references" | "empty-id-with-path" | "id-with-empty-path" | "wrong-session";
  let tamperNextInspect: TamperMode | undefined;
  let inspectCalls = 0;
  const recoveryCalls: string[] = [];
  await page.routeWebSocket("**/*", (socket): void => {
    const server = socket.connectToServer();
    socket.onMessage((message): void => {
      if (typeof message === "string") {
        const request = JSON.parse(message) as { method?: string };
        if (request.method === "session.inspect") {
          inspectCalls += 1;
        }
        if (request.method === "session.resume") {
          recoveryCalls.push(request.method);
        }
      }
      server.send(message);
    });
    server.onMessage((message): void => {
      if (tamperNextInspect !== undefined && typeof message === "string") {
        const response = JSON.parse(message) as unknown;
        if (typeof response === "object" && response !== null && "ok" in response
          && typeof response.ok === "object" && response.ok !== null
          && "id" in response.ok && response.ok.id === FIXTURE_LOCAL_STOPPED_SESSION_ID
          && "native_session_id" in response.ok) {
          if (tamperNextInspect === "both-references") {
            Object.assign(response.ok, { native_session_path: "/ambiguous/conversation" });
          } else if (tamperNextInspect === "empty-id-with-path") {
            Object.assign(response.ok, { native_session_id: "", native_session_path: "/valid/conversation" });
          } else if (tamperNextInspect === "id-with-empty-path") {
            Object.assign(response.ok, { native_session_path: "" });
          } else {
            (response.ok as { id: string }).id = "fixture-other-session";
          }
          tamperNextInspect = undefined;
          socket.send(JSON.stringify(response));
          return;
        }
      }
      socket.send(message);
    });
  });

  const address = stack.local.tcpAddress;
  if (address === undefined) throw new Error("fixture local daemon did not expose a TCP address");
  const client = await connectTcp(FIXTURE_LOCAL_HOST, address);
  try {
    const countBefore = (await client.call("session.list", {})).length;
    await page.goto(stack.backend.url);
    const row = page.locator(`[data-testid="session-row"][data-host="${FIXTURE_LOCAL_HOST}"][data-session-id="${FIXTURE_LOCAL_STOPPED_SESSION_ID}"]`);
    await row.click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();

    for (const mode of ["both-references", "empty-id-with-path", "id-with-empty-path"] as const) {
      tamperNextInspect = mode;
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await expect.poll(() => tamperNextInspect).toBeUndefined();
      await expect(page.getByRole("dialog", { name: "Resume session?" })).toHaveCount(0);
      await expect(page.getByText("Recovery target unavailable: session.inspect returned an invalid target").last()).toBeVisible();
      expect(inspectCalls).toBeGreaterThan(0);
      expect(recoveryCalls).toEqual([]);
      expect((await client.call("session.list", {})).length).toBe(countBefore);
    }

    tamperNextInspect = "wrong-session";
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect.poll(() => tamperNextInspect).toBeUndefined();
    await expect(page.getByRole("dialog", { name: "Resume session?" })).toHaveCount(0);
    expect(recoveryCalls).toEqual([]);

    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Resume session?" });
    await expect(confirmation).toContainText(FIXTURE_LOCAL_RECOVERY_ID);
    tamperNextInspect = "wrong-session";
    await confirmation.getByRole("button", { name: "Resume session" }).click();
    await expect.poll(() => tamperNextInspect).toBeUndefined();
    await expect(confirmation).toHaveCount(0);
    expect(recoveryCalls).toEqual([]);
    expect((await client.call("session.list", {})).length).toBe(countBefore);
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  } finally {
    await client.close();
  }
});

test("resume confirms the inspected conversation when the browser list is stale", async ({ page, stack }) => {
  let staleListInjected = false;
  await page.routeWebSocket("**/*", (socket): void => {
    const server = socket.connectToServer();
    server.onMessage((message): void => {
      if (typeof message === "string") {
        const response = JSON.parse(message) as unknown;
        if (typeof response === "object" && response !== null && "ok" in response && Array.isArray(response.ok)) {
          const sessions = response.ok as unknown[];
          const localSession = sessions.find((entry): entry is { id: string } =>
            typeof entry === "object" && entry !== null && "id" in entry && entry.id === FIXTURE_LOCAL_STOPPED_SESSION_ID);
          if (localSession !== undefined) {
            // Keep the daemon's seeded recovery target intact; delay only the browser's list view.
            Object.assign(localSession, { native_session_id: STALE_RECOVERY_ID });
            staleListInjected = true;
            socket.send(JSON.stringify(response));
            return;
          }
        }
      }
      socket.send(message);
    });
  });

  const address = stack.local.tcpAddress;
  if (address === undefined) throw new Error("fixture local daemon did not expose a TCP address");
  const client = await connectTcp(FIXTURE_LOCAL_HOST, address);
  try {
    await page.goto(stack.backend.url);
    const row = page.locator(`[data-testid="session-row"][data-host="${FIXTURE_LOCAL_HOST}"][data-session-id="${FIXTURE_LOCAL_STOPPED_SESSION_ID}"]`);
    await expect(row).toContainText(STALE_RECOVERY_ID);
    expect(staleListInjected).toBe(true);
    expect((await client.call("session.inspect", FIXTURE_LOCAL_STOPPED_SESSION_ID)).native_session_id).toBe(FIXTURE_LOCAL_RECOVERY_ID);

    await row.click();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Resume session?" });
    await expect(confirmation).toContainText(FIXTURE_LOCAL_RECOVERY_ID);
    await expect(confirmation).toContainText(FIXTURE_LOCAL_NATIVE_ACTIVITY);
    await expect(confirmation).not.toContainText(STALE_RECOVERY_ID);

    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const secondConfirmation = page.getByRole("dialog", { name: "Resume session?" });
    await expect(secondConfirmation).toContainText(FIXTURE_LOCAL_RECOVERY_ID);
    await secondConfirmation.getByRole("button", { name: "Resume session" }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  } finally {
    await client.close();
  }
});

test("resume requires a new confirmation when the inspected target changes", async ({ page, stack }) => {
  let delayOneInspect = false;
  await page.routeWebSocket("**/*", (socket): void => {
    const server = socket.connectToServer();
    server.onMessage((message): void => {
      if (delayOneInspect && typeof message === "string") {
        const response = JSON.parse(message) as unknown;
        if (typeof response === "object" && response !== null && "ok" in response
          && typeof response.ok === "object" && response.ok !== null
          && "id" in response.ok && response.ok.id === FIXTURE_LOCAL_STOPPED_SESSION_ID) {
          // Model an inspect response captured just before a native target switch.
          Object.assign(response.ok, { native_session_id: STALE_RECOVERY_ID });
          delayOneInspect = false;
          socket.send(JSON.stringify(response));
          return;
        }
      }
      socket.send(message);
    });
  });

  await page.goto(stack.backend.url);
  await page.locator(`[data-testid="session-row"][data-host="${FIXTURE_LOCAL_HOST}"][data-session-id="${FIXTURE_LOCAL_STOPPED_SESSION_ID}"]`).click();
  delayOneInspect = true;
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Resume session?" });
  await expect(confirmation).toContainText(STALE_RECOVERY_ID);
  await expect(confirmation).toContainText(FIXTURE_LOCAL_NATIVE_ACTIVITY);
  expect(delayOneInspect).toBe(false);

  await confirmation.getByRole("button", { name: "Resume session" }).click();
  await expect(confirmation).toContainText(FIXTURE_LOCAL_RECOVERY_ID);
  await expect(confirmation).not.toContainText(STALE_RECOVERY_ID);

  await confirmation.getByRole("button", { name: "Resume session" }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
});
