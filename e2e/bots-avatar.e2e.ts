/**
 * A Bot's avatar is an image the reader uploads, and every face of that Bot shows it.
 *
 * The image lives beside the Bot it belongs to and is served by the asset route, so
 * the sidebar row, the settings header, and the assistant's message row all draw the
 * same bytes. Removing it brings the initial back.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** The composer takes its accessible name from its own placeholder. */
const COMPOSER_NAME = "What would you like to know?";

/** The built-in Bot's display name; the avatar's alt text carries the same string. */
const BOT_NAME = "Aify";

const MESSAGE = "Handle this one first";
const ANSWER = "Got the first message.";

/** A 1×1 transparent PNG: enough for the magic-byte check, small enough to inline. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

test("a Bot's uploaded avatar reaches every face of that Bot", async ({
  page,
}) => {
  const uploadDir = mkdtempSync(path.join(tmpdir(), "aify-avatar-"));
  const avatarFile = path.join(uploadDir, "avatar.png");
  writeFileSync(avatarFile, PNG);

  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "slow-answer" });
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
    await expect(page).toHaveURL(/\/sessions\/[^/?]+/u);

    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(MESSAGE);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(ANSWER).first()).toBeVisible();

    // Open the Bot's settings through its own row menu, found without the name.
    const botRow = page
      .getByRole("button", { name: "Bot actions" })
      .first()
      .locator("xpath=ancestor::li[1]");
    await botRow.locator("span[aria-label]").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Configure" }).click();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/general$/u);

    // Before the upload, the avatar has no image at all: the initial is the face.
    await expect(page.locator(`img[alt="${BOT_NAME}"]`)).toHaveCount(0);

    await page.getByLabel("Upload image").setInputFiles(avatarFile);

    // The settings header and the sidebar row both show the uploaded bytes.
    await expect(page.locator(`img[alt="${BOT_NAME}"]`).first()).toBeVisible();

    // Back in the session, two faces carry the same bytes: the sidebar row and the
    // assistant message row that the Bot spoke.
    await page.getByRole("button", { name: "Back to app" }).click();
    const faces = page.locator(`img[alt="${BOT_NAME}"]`);
    await expect(faces).toHaveCount(2);

    // The image was stored, not held in memory: a reload still shows both.
    await page.reload();
    await expect(faces).toHaveCount(2);

    // Removing the image brings the initial back.
    const reopenedRow = page
      .getByRole("button", { name: "Bot actions" })
      .first()
      .locator("xpath=ancestor::li[1]");
    await reopenedRow
      .locator("span[aria-label]")
      .first()
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Configure" }).click();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/settings\/general$/u);

    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.locator(`img[alt="${BOT_NAME}"]`)).toHaveCount(0);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
