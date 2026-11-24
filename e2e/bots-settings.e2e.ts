/**
 * One Bot's settings are addresses, drawn over the session.
 *
 * Each section has its own address, so a reader can send someone a section and
 * reload it. The bare Bot address and `/settings` name no section, so both hand
 * the reader to the first section instead of rendering a section-less screen.
 *
 * The scenario is `slow-answer`: the first chunk arrives after three seconds,
 * which keeps the run alive while the reader is in the Bot settings.
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** The composer takes its accessible name from its own placeholder. */
const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "Handle this one first";
const DRAFT = "This draft is not sent yet.";
const ANSWER = "Got the first message.";

test("Bot settings are addresses and cover the session", async ({ page }) => {
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

    await expect(page).toHaveURL(/\/sessions\/[^/?]+/u);
    const sessionUrl = page.url();

    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(MESSAGE);
    await page.getByRole("button", { name: "Send" }).click();

    // A draft typed while the run streams. It must survive the trip into the
    // Bot settings and back.
    await composer.click();
    await page.keyboard.type(DRAFT);

    // The Bot row's own menu opens its settings. The row is found by its menu
    // button, not by the Bot's display name: the name is data a reader can edit,
    // and this test is about addresses.
    const botRow = page
      .getByRole("button", { name: "Bot actions" })
      .first()
      .locator("xpath=ancestor::li[1]");
    await botRow.locator("span[aria-label]").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Configure" }).click();

    // The bare Bot address names a section by itself.
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/general$/u);
    const botBase = new URL(page.url()).pathname.replace(
      /\/settings\/general$/u,
      ""
    );
    await expect(
      page.getByRole("button", { name: "Back to app" })
    ).toBeVisible();

    // The run finishes behind the dialog: the session stream kept running while
    // the session was covered.
    await expect(page.getByText(ANSWER).first()).toBeVisible();

    // A section is a route: moving between them is navigation, not a tab swap.
    await page.getByRole("button", { name: "MCP servers" }).click();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/mcp$/u);
    await page.goBack();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/general$/u);

    // Closing steps over the sections that were opened: the way back is the
    // session, not the previous section.
    await page.getByRole("button", { name: "Skills" }).click();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/skills$/u);
    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(page).toHaveURL(sessionUrl);

    // Same instance: the draft survived, and the turn was not replayed.
    await expect(composer).toContainText(DRAFT);
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(1);
    await expect(page.getByText(ANSWER).first()).toBeVisible();

    // The bare Bot address names no section, so it hands the reader to the first
    // one, and `replace` keeps that hand-over out of the history: walking back
    // lands on the page that was open before, not on the address it replaced.
    await page.goto(new URL(botBase, sessionUrl).href);
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/general$/u);
    await page.goBack();
    await expect(page).toHaveURL(sessionUrl);

    // `/bots/<uuid>/settings` is the same kind of address, by the same rule.
    await page.goto(new URL(`${botBase}/settings`, sessionUrl).href);
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/general$/u);

    // A section address can be opened on its own, and survives a reload.
    await page.goto(new URL(`${botBase}/settings/mcp`, sessionUrl).href);
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/mcp$/u);
    await page.reload();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/mcp$/u);
    await expect(
      page.getByRole("button", { name: "MCP servers" })
    ).toBeVisible();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
