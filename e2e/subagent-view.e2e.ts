/**
 * The subagent view: when the address names a subagent, the tab in the right
 * panel must draw that session's record.
 *
 * No real subagent is made here. The fake provider cannot issue a `task` call,
 * and the view needs nothing more than the record of one session — so the case
 * puts the current session's own id in the address as the subagent id. The chain
 * it drives is the real one: address, panel, record.
 *
 * The assertions are on what a reader sees: the record has height (it is not a
 * clipped blank), the answer is inside it, and the parent record still stands.
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "Update the second line in notes.md";
const ANSWER = "The second line is updated.";

test("The subagent view draws the record the address names", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack();

    await page.goto(stack.loginUrl);
    await expect(page.getByText("No projects", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New project" }).click();
    await page.getByPlaceholder("My project").fill(PROJECT_NAME);
    await page
      .getByPlaceholder("/Users/me/code/my-project")
      .fill(stack.projectDir);
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByText(PROJECT_NAME)).toBeVisible();

    await page.getByText(PROJECT_NAME).first().hover();
    await page
      .getByRole("button", { name: "New session in this project" })
      .click();

    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(MESSAGE);
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();

    await expect(page.getByText(ANSWER)).toBeVisible();

    // The session is its own subagent: the view reads that session's record.
    const sessionUrl = new URL(page.url());
    const sessionId = sessionUrl.pathname.split("/").at(-1);
    expect(sessionId).toBeTruthy();

    await page.goto(
      `${sessionUrl.origin}${sessionUrl.pathname}?subagent=${sessionId}`
    );

    // One assertion per step, so a failure names the step that broke: was the tab
    // built, did the panel open, did the record mount, and does it have height.
    const subagent = page.getByRole("tabpanel", { name: "Subagent" });
    await expect(subagent).toBeVisible();

    const tabBox = await subagent.boundingBox();
    expect(tabBox?.width ?? 0, "the panel is collapsed").toBeGreaterThan(0);

    const viewport = subagent.locator(
      '[data-slot="message-scroller-viewport"]'
    );
    await expect(viewport, "the record is not shown").toBeVisible();

    const box = await viewport.boundingBox();
    expect(box?.height ?? 0, "the record has no height").toBeGreaterThan(0);

    await expect(subagent).toContainText(ANSWER);
    // The parent record did not give way: the left one is still there, first.
    await expect(page.getByRole("log").first()).toContainText(MESSAGE);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
