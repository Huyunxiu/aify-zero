/**
 * Settings covers the session; it does not replace it.
 *
 * The run is still streaming when settings opens, and the draft typed before it
 * was never submitted. Coming back must show the same session: one finished
 * turn, no replay, the draft still in the composer. The address has to say where
 * the reader is at every step, sections included.
 *
 * The scenario is `slow-answer`: the first chunk arrives after three seconds,
 * which keeps the run alive while the reader is in settings.
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "先处理这一条";
const DRAFT = "这是还没发出去的草稿。";
const ANSWER = "第一句收到。";

test("Settings covers the session without unmounting it", async ({ page }) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "slow-answer" });
    const { loginUrl } = stack;

    await page.goto(loginUrl);
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

    // The address names the session. It did not before: memory history held the
    // location in memory and left the address alone.
    await expect(page).toHaveURL(/\/sessions\/[^/?]+/u);
    const sessionUrl = page.url();

    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(MESSAGE);
    await page.getByRole("button", { name: "Send" }).click();

    // A draft typed while the run streams. The composer accepts it: a message
    // sent now would steer the run rather than wait for it.
    await composer.click();
    await page.keyboard.type(DRAFT);

    // Settings is an address, and `/settings` names a section by itself.
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings\/general$/u);
    await expect(
      page.getByRole("button", { name: "Back to app" })
    ).toBeVisible();

    // The run finishes behind the dialog. The answer can only be here if the
    // session event stream kept running while the session was covered.
    await expect(page.getByText(ANSWER).first()).toBeVisible();

    // A section is a route: moving between them is navigation, not a tab swap.
    await page.getByRole("button", { name: "Appearance" }).click();
    await expect(page).toHaveURL(/\/settings\/appearance$/u);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/general$/u);

    // The way back is the session that was open, not the session list.
    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(page).toHaveURL(sessionUrl);

    // Same instance: the draft survived, and the turn was not replayed.
    await expect(composer).toContainText(DRAFT);
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(1);
    await expect(page.getByText(ANSWER).first()).toBeVisible();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
