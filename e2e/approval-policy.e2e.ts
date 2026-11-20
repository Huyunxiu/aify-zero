/**
 * Approval policy: the policy that a session stores decides who gets asked.
 *
 * Three seams, and each one is reachable only end to end:
 * - a policy that allows the class lets the change land, and no card appears;
 * - a policy that refuses the class keeps the file as it was, and no card appears;
 * - a timer run tightens the stored policy, so the card appears again.
 *
 * The policy matrix (policy x class, host rules, hooks) belongs to the table tests
 * in `packages/agent/tests`. A hook, an MCP annotation, a subagent, a fork, and
 * compaction are out of scope here: they cannot be reached from this stack.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** The composer is reachable by its own placeholder (`prompt-input-tiptap.tsx`). */
const COMPOSER_NAME = "What would you like to know?";

/** The line the model writes; the cases read it from disk. */
const EDITED_LINE = "second line edited";

/** The two answers of the timer case: one sets the timer, one follows it. */
const FIRST_ANSWER = "The timer is set; I will stop here.";
const SECOND_ANSWER = "The timer fired; I updated the file.";

/** The timer waits for a full minute, longer than the default expect timeout. */
const TIMER_TIMEOUT_MS = 90_000;

/** Create a project and a session; return the field that accepts text. */
async function openSession(page: Page, stack: Stack): Promise<Locator> {
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

  // The composer shows the stored policy as its own button. A new session has no
  // row yet, so the first message carries the choice; until then the trigger shows
  // the default.
  await expect(
    page.getByRole("button", { name: "Edit", exact: true })
  ).toBeVisible();
  return page.getByRole("textbox", { name: COMPOSER_NAME });
}

/** Pick a policy in the composer, and wait for the button to show it. */
async function choosePolicy(page: Page, name: "Edit" | "Read-only") {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: new RegExp(`^${name}`, "u") })
    .click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
}

/** Send one message, and wait for the send button to become enabled. */
async function send(page: Page, composer: Locator, message: string) {
  await composer.click();
  await page.keyboard.type(message);
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
}

/** The file the scenario edits. A case asserts the file, not a sentence. */
function notesFile(stack: Stack): string {
  return readFileSync(join(stack.projectDir, "notes.md"), "utf-8");
}

test("Edit: a change lands without a card", async ({ page }) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack();
    const composer = await openSession(page, stack);

    await choosePolicy(page, "Edit");
    await send(page, composer, "Update the second line in notes.md");

    // The tool row appears because the call ran; the turn ends without a
    // question, and the file on disk shows the edit.
    await expect(
      page.getByRole("button", { name: /^Edit/u }).first()
    ).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    expect(notesFile(stack)).toContain(EDITED_LINE);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});

test("Read-only: the change is refused and the file stays as it was", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack();
    const before = notesFile(stack);
    const composer = await openSession(page, stack);

    await choosePolicy(page, "Read-only");
    await send(page, composer, "Update the second line in notes.md");

    // A refusal is an answer, not a question: the turn ends, no card asks for
    // anything, and the file keeps the text it had.
    await expect(page.getByText("Finished", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    expect(notesFile(stack)).toBe(before);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});

test("Unattended: a timer run asks even when the session stores Edit", async ({
  page,
}) => {
  test.setTimeout(180_000);

  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({
      scenario: {
        name: "approval-timer",
        models: ["fake-fast"],
        rules: [
          // Title generation is not a stream; split it off so it does not eat
          // a rule that belongs to the conversation.
          { when: { stream: false }, answer: "Timer" },
          {
            when: { stream: true },
            toolCall: {
              name: "timer-set",
              args: {
                note: "Update the file when the timer fires",
                afterSeconds: 60,
              },
            },
          },
          { when: { stream: true }, answer: FIRST_ANSWER },
          {
            when: { stream: true },
            toolCall: {
              name: "edit-file",
              args: {
                path: "notes.md",
                edits: [{ oldText: "second line", newText: EDITED_LINE }],
              },
            },
          },
          { when: { stream: true }, answer: SECOND_ANSWER },
          { when: { stream: false }, answer: "Timer follow-up" },
        ],
      },
    });
    const composer = await openSession(page, stack);

    await choosePolicy(page, "Edit");
    await send(page, composer, "Set a timer to update the file in one minute");
    await expect(page.getByText(FIRST_ANSWER)).toBeVisible();

    // The timer run starts with no person present. The stored policy is Edit, but
    // the runner tightens it to the cautious posture, so the change waits for an answer.
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
      timeout: TIMER_TIMEOUT_MS,
    });
    await expect(
      page.getByText("Awaiting review", { exact: true })
    ).toBeVisible();

    // The answer lets the same run continue, and the edit lands.
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(SECOND_ANSWER)).toBeVisible();
    expect(notesFile(stack)).toContain(EDITED_LINE);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
