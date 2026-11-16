/**
 * 主流程冒烟：建项目 → 建会话 → 发一句 → 工具改文件 → 在改动面板看到那一行。
 *
 * 这条用例穿过浏览器、本机 API、运行器、host 沙箱、磁盘和改动面板。模型侧由假
 * 供应商应答，所以每一段的输入都是确定的。
 *
 * 断言只落在用户看得见的东西上：文字、按钮、文件内容。页面里的类名和 DOM 结构
 * 不在断言范围内。
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

test("主流程：建项目 → 发消息 → 工具改文件 → 改动面板看到那一行", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack();
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

    // 4. 输入一句话并发送。发送按钮在选到模型之前是禁用的。
    const composer = page.locator('[data-slot="input-group-control"]');
    await composer.click();
    await page.keyboard.type("把 notes.md 的第二行改一下");
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();

    // 5. 用户消息出现在会话里。
    await expect(
      page.locator('[data-slot="message"][data-align="end"]')
    ).toContainText("把 notes.md 的第二行改一下");

    // 6. 工具步骤出现：名字是 `Edit` 加细节，工具真的跑过才可能有这一行。
    await expect(
      page.getByRole("button", { name: /^Edit/u }).first()
    ).toBeVisible();

    // 7. 这一轮的终态由页面自己说：`Finished`，回答文字也在里面。
    await expect(page.getByText("Finished", { exact: true })).toBeVisible();
    await expect(page.getByText("已把第二行改好。")).toBeVisible();

    // 8. 右侧面板默认收起，收起时里面的内容是 `inert`，点不动。先点右上角的入口
    //    把它展开，再选「改动」。侧栏状态不参与断言：一轮结束后它回到 `Idle`。
    await page.getByLabel("Files", { exact: true }).click();
    await page.getByRole("button", { name: "Changes" }).click();

    // 9. 改动列表里有那个文件，改后的那一行能在面板里看到。断言限定在改动标签页
    //    里：会话正文里也有 `notes.md`（用户消息与工具行）。
    const review = page.getByRole("tabpanel", { name: /Changes/u });
    await expect(review).toContainText("1 files changed");
    await review.getByRole("treeitem", { name: /notes\.md/u }).click();
    await expect(review).toContainText("第二行已改");

    // 请求序列是这一层唯一的硬证据：1 次非流式的标题请求，2 次流式的正文请求
    // （先要工具、再回答）。标题与主回合并发，所以只断言次数，不咬死顺序。
    expect(
      stack.fake.requests.filter((request) => request.stream)
    ).toHaveLength(2);
    expect(
      stack.fake.requests.filter((request) => !request.stream)
    ).toHaveLength(1);
    expect(
      stack.fake.requests.every((request) => request.model === "fake-fast")
    ).toBe(true);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // 失败留现场，成功删干净。
    await stack?.stop({ keep: failed });
  }
});
