/**
 * 子会话视图：地址指名一个子会话时，右栏那个标签要真的画出它的记录。
 *
 * 这里不生成真的子代理。假供应商派不出 `task` 调用，而视图要的只是「一条会话
 * 的记录」——所以用例把当前会话自己的 id 当成子会话 id 放进地址。这样走的是
 * 真实的读取链：地址 → 面板 → 记录。
 *
 * 断言落在两件用户看得见的事上：记录有高度（不是一块被裁掉的空白），以及那句
 * 回答在里面。父会话的记录同时仍然看得见。
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

    // 这条会话自己当子会话：视图读的就是这条会话的记录。
    const sessionUrl = new URL(page.url());
    const sessionId = sessionUrl.pathname.split("/").at(-1);
    expect(sessionId).toBeTruthy();

    await page.goto(
      `${sessionUrl.origin}${sessionUrl.pathname}?subagent=${sessionId}`
    );

    // 一层一层断言，失败落在哪一步就说清断在哪：标签有没有建出来、面板有没有
    // 展开、记录有没有挂上、挂上以后有没有高度。
    const subagent = page.getByRole("tabpanel", { name: "Subagent" });
    await expect(subagent).toBeVisible();

    const tabBox = await subagent.boundingBox();
    expect(tabBox?.width ?? 0, "the panel is collapsed").toBeGreaterThan(0);

    const viewport = subagent.locator(
      '[data-slot="message-scroller-viewport"]'
    );
    await expect(viewport, "the record never mounted").toBeVisible();

    const box = await viewport.boundingBox();
    expect(box?.height ?? 0, "the record has no height").toBeGreaterThan(0);

    await expect(subagent).toContainText(ANSWER);
    // 父会话的记录没有让位：它仍在左栏。
    await expect(page.getByRole("log").getByText(MESSAGE)).toBeVisible();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
