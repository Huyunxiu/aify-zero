/**
 * 删除会话：从侧栏的行菜单删掉一个会话，它从列表里消失，页面回到空白态。
 *
 * 这条用例穿过的接缝是「服务端把会话藏起来 ↔ 侧栏不再画它 ↔ 当前打开的页面让开」。
 * 断言只落在用户看得见的东西上：文字，以及刷新之后还在不在。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案。 */
const COMPOSER_NAME = "What would you like to know?";

/** 场景给两次标题生成两个不同的回答，所以这两段文字各自只属于一个会话。 */
const KEPT = "Session one";
const REMOVED = "Session two";

/**
 * 侧栏里那一条会话行。
 *
 * 标题文字在正文头部还有一份，两边各自独立取数：列表要等下一次查询才画出
 * 新会话，头部先有。按文字定位会先命中头部，右键就落在一个没有菜单的元素
 * 上。行按钮的可访问名带着标题，只存在于列表里。
 */
const sessionRow = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(title) });

test("Session delete: the removed session leaves the list and the page", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "session-delete" });
    await page.goto(stack.loginUrl);

    // 顶部那颗「新建会话」按钮是唯一带文字的：分组标题上的同名入口只有图标。
    const newSession = page.getByText("New Session", { exact: true });

    // 1. 留下一个会话：删掉另一个之后，它必须还在。
    await newSession.click();
    await sendAndSettle(page, "First message");
    await expect(sessionRow(page, KEPT)).toBeVisible();

    // 2. 再建一个，并且停在它里面——删除要顺带把页面让开。
    //
    //    先跨过一个整秒：`updated_at` 是整秒精度，两个会话落在同一秒的话，
    //    列表顺序不确定，刷新后的断言就分不清是谁。
    await page.waitForTimeout(1100);
    await newSession.click();
    await sendAndSettle(page, "Second message");
    await expect(sessionRow(page, REMOVED)).toBeVisible();

    // 3. 右键这一行，和鼠标用户看到的是同一个菜单。
    await sessionRow(page, REMOVED).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();

    // 4. 确认框里写的是哪一个会话。
    await expect(
      page.getByText("Delete session", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // 5. 列表少一行，页面回到空白态，另一个会话还在。
    //
    //    空白态认文字，不认地址：新建会话的入口本来就在根路径上，`/sessions`
    //    也渲染同一个页面。
    await expect(page.getByText(REMOVED, { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Start a session", { exact: true })
    ).toBeVisible();
    await expect(sessionRow(page, KEPT)).toBeVisible();

    // 6. 刷新之后仍然是删掉的状态：藏起来的是服务端，不是缓存。
    await page.reload();
    await expect(page.getByText(REMOVED, { exact: true })).toHaveCount(0);
    await expect(sessionRow(page, KEPT)).toBeVisible();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});

/**
 * 发一句，等这个页面多出一个收尾的回合。
 *
 * 按「现在有几个 `Finished`」加一等，而不是等一个绝对数。
 */
async function sendAndSettle(page: Page, message: string) {
  const finished = page.getByText("Finished", { exact: true });
  const before = await finished.count();

  const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
  await composer.click();
  await page.keyboard.type(message);

  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();

  await expect(finished).toHaveCount(before + 1);
}
