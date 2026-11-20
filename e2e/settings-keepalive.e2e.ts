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

/** The composer takes its accessible name from its own placeholder. */
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

    // And the session was not marked read: the reader could not see it. The
    // sidebar behind the dialog still holds the unread tick. The dialog hides
    // the rest of the page from the accessibility tree, so the tick is matched
    // by its own label attribute rather than through a role query.
    await expect(page.locator('[aria-label="Done"]').first()).toBeVisible();

    // A section is a route: moving between them is navigation, not a tab swap.
    // Back walks them one by one, and each step keeps the previous screen.
    await page.getByRole("button", { name: "Appearance" }).click();
    await expect(page).toHaveURL(/\/settings\/appearance$/u);
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page).toHaveURL(/\/settings\/provider$/u);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/appearance$/u);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/general$/u);

    // The way back is the session that was open, not the previous section: one
    // step per section opened would land the reader on Appearance again.
    await page.getByRole("button", { name: "Appearance" }).click();
    await expect(page).toHaveURL(/\/settings\/appearance$/u);
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page).toHaveURL(/\/settings\/provider$/u);
    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(page).toHaveURL(sessionUrl);

    // Same instance: the draft survived, and the turn was not replayed.
    await expect(composer).toContainText(DRAFT);
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(1);
    await expect(page.getByText(ANSWER).first()).toBeVisible();

    // Seen at last: the tick goes away.
    await expect(page.locator('[aria-label="Idle"]').first()).toBeVisible();

    // A section address can be opened on its own, and survives a reload.
    await page.goto(new URL("/settings/provider", sessionUrl).href);
    await expect(page).toHaveURL(/\/settings\/provider$/u);
    await page.reload();
    await expect(page).toHaveURL(/\/settings\/provider$/u);
    await expect(page.getByText("Providers").first()).toBeVisible();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});

test("Settings from the session list keeps the draft", async ({ page }) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack();
    await page.goto(stack.loginUrl);

    // The list has no session id: its screen is the draft. It is the same
    // session host, so a covering route must remember the draft too.
    await expect(page).toHaveURL(/\/sessions$/u);

    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(DRAFT);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings\/general$/u);

    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(page).toHaveURL(/\/sessions$/u);
    await expect(composer).toContainText(DRAFT);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
