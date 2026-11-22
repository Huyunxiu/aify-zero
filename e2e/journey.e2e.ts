/**
 * 主流程冒烟：建项目 → 建会话 → 发一句 → 工具改文件 → 在改动视图看到那一行。
 *
 * 这条用例穿过浏览器、本机 API、运行器、host 沙箱、磁盘和改动视图。模型侧由假
 * 供应商应答，所以每一段的输入都是确定的。
 *
 * 断言只落在用户看得见的东西上：文字、可访问名、文件内容。类名和 DOM 结构不在
 * 断言范围内。
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "Update the second line in notes.md";

test("Main journey: create project → send message → tool edits file → Changes view shows the edited line", async ({
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
    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(MESSAGE);
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();

    // 5. 用户消息出现在会话里。
    await expect(page.getByRole("log").getByText(MESSAGE)).toBeVisible();

    // 6. 工具步骤出现：名字是 `Edit` 加细节。默认策略是「编辑」，改动类直接放行，
    //    所以这一行不会停在「等待批准」上。
    await expect(
      page.getByRole("button", { name: /^Edit/u }).first()
    ).toBeVisible();

    // 7. 回合的终态由页面自己说：`Finished`，回答文字也在。
    await expect(page.getByText("Finished", { exact: true })).toBeVisible();
    await expect(page.getByText("The second line is updated.")).toBeVisible();

    // 8. 右侧会话面板默认收起，收起时里面的内容是 `inert`，点不动。先点右上角的
    //    入口把它展开，再选「改动」。侧栏状态不参与断言：一个回合结束后它回到
    //    `Idle`。
    await page.getByLabel("Files", { exact: true }).click();
    await page.getByRole("button", { name: "Changes" }).click();

    // 9. 改动视图里有那个文件，改后的那一行能在里面看到。断言限定在改动标签页：
    //    会话正文里也有 `notes.md`（用户消息与工具行）。
    const review = page.getByRole("tabpanel", { name: /Changes/u });
    await expect(review).toContainText("1 files changed");
    await review.getByRole("treeitem", { name: /notes\.md/u }).click();
    await expect(review).toContainText("second line edited");

    // 请求序列是这一层唯一的硬证据：1 次非流式的标题请求，2 次流式的正文请求
    // （先要工具、再回答）。标题与主回合并发，所以只数次数，不咬死顺序。
    const streams = stack.fake.requests.filter((request) => request.stream);
    const titles = stack.fake.requests.filter((request) => !request.stream);
    expect(streams).toHaveLength(2);
    expect(titles).toHaveLength(1);
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
