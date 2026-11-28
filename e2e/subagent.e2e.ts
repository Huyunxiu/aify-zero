/**
 * 子代理：派活的那次调用在子代理还在跑的时候就返回，子代理落定后以一条通知
 * 回到父会话，父会话被它唤醒并作答。
 *
 * 这条用例穿过浏览器、本机 API、运行器、子代理工厂、子代理自己那次运行、通知
 * 写入口和收件箱。模型侧由假供应商应答：父会话两条、子代理一条、被通知唤醒的
 * 父会话一条。
 *
 * 父子两边用的是同一个假供应商、同一个模型、都是流式请求，所以规则只能靠请求
 * 体区分——子代理的系统提示里有那句 a subagent launched by a parent agent，父
 * 会话的提示里没有。`when.bodyContains` 就是为这件事加的。
 *
 * 断言只落在用户看得见的东西和请求序列上。请求序列是「派活没有等待」的唯一
 * 硬证据：报告的文字出现在通知里，而不是出现在第二个工具的返回值里。
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "Start a subagent that finds the router";

/** 通知块的标签（`subagentNotice.marker`）。界面语言走 i18n 默认值 en-US。 */
const NOTICE_MARKER = "Subagent finished";

/** 父会话拿到名字就走了；子代理还在跑的时候，这一句已经出现。 */
const FIRST_ANSWER = "Started AGENT-1. It will report when it is done.";

/** 子代理的报告原文。它只该从通知里出现，不该来自任何一次工具返回。 */
const REPORT = "The router is in apps/server/src/router.ts.";

/** 被通知唤醒的那个回合；有这个回合，才说明通知真的开了一轮。 */
const SECOND_ANSWER =
  "AGENT-1 says the router is in apps/server/src/router.ts.";

/** 子代理系统提示里的那一句；父会话的提示里没有它。 */
const SUBAGENT_PROMPT = "launched by a parent agent";

test("Subagent: the call returns while it works → the settlement wakes the parent → the parent answers", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "subagent" });
    const { loginUrl } = stack;

    // 1. 用 server 打印的登录链接进去，侧栏出现。
    await page.goto(loginUrl);
    await expect(page.getByText("No projects", { exact: true })).toBeVisible();

    // 2. 新建项目，主目录指向临时的 Git 仓库。
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByPlaceholder("My project").fill(PROJECT_NAME);
    await page
      .getByPlaceholder("/Users/me/code/my-project")
      .fill(stack.projectDir);
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByText(PROJECT_NAME)).toBeVisible();

    // 3. 在项目里新建会话（按钮要悬停才可点）。
    await page.getByText(PROJECT_NAME).first().hover();
    await page
      .getByRole("button", { name: "New session in this project" })
      .click();

    // 4. 发一句话。发送按钮在选到模型之前是禁用的。
    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(MESSAGE);
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();

    // 5. 派活那一行出现：它记的是子代理的类型和 description。
    await expect(
      page.getByRole("button", { name: /^Subagent/u }).first()
    ).toBeVisible();

    // 6. 父会话的第一轮已经结束，而子代理还在跑（场景里它要等 1.5 秒才开口）：
    //    这一句结束时，报告还没有出现在任何地方。这就是「没有等待」。
    await expect(page.getByText(FIRST_ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(1);
    await expect(page.getByText(REPORT)).toHaveCount(0);

    // 7. 子代理落定，通知出现。它是独立的一块，不是用户气泡。
    const notice = page.getByRole("note", { name: NOTICE_MARKER });
    await expect(notice).toBeVisible();

    // 8. 通知里带着名字和报告原文：报告是通知带回来的，不是另一次工具调用的
    //    结果，所以父会话不必再取一次。
    await expect(notice).toContainText("AGENT-1");
    await expect(notice).toContainText(REPORT);

    // 9. 通知里没有任何动作按钮：不能复制、不能重新生成，也不进输入框。
    await expect(notice.getByRole("button")).toHaveCount(0);

    // 10. 空闲的父会话被唤醒，第二个回合自己跑起来并收尾。
    await expect(page.getByText(SECOND_ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(2);

    // 11. 请求序列是这一层唯一的硬证据。流式请求 4 次：派活、父会话第一轮
    //     作答、子代理作答、被通知唤醒的那一轮。子代理的请求只有 1 次，而且它
    //     的请求体里带着只有子代理才有的那句提示——一个独立运行，不是同一轮
    //     里的第二次调用。
    const streams = stack.fake.requests.filter((request) => request.stream);
    const childRequests = stack.fake.requests.filter((request) =>
      JSON.stringify(request.body).includes(SUBAGENT_PROMPT)
    );
    expect(streams).toHaveLength(4);
    expect(childRequests).toHaveLength(1);
    expect(
      stack.fake.requests.every((request) => request.model === "fake-fast")
    ).toBe(true);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
