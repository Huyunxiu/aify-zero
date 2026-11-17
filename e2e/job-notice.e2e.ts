/**
 * 完成通知：后台任务结算后，通知落进收件箱，把空闲的会话唤醒。
 *
 * 这条用例穿过浏览器、本机 API、运行器、host 沙箱、任务注册表和收件箱。模型侧
 * 由假供应商应答：先要一次后台命令，再等任务结算，最后被通知唤醒后作答。
 *
 * 断言只落在用户看得见的东西上：文字、可访问名、通知块的形状。
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "在后台跑一条命令";

/** 通知块的标签（`jobNotice.marker`）。界面语言走 i18n 默认值 en-US。 */
const NOTICE_MARKER = "Background job finished";

/** 通知正文里那段内联输出；场景里后台命令打印的就是它。 */
const JOB_OUTPUT = "done";

/** 任务结算后的状态行；通知带上它，说明任务真的跑完了。 */
const JOB_STATUS = "[status: completed, exit code: 0]";

/** 后台命令本身出现在通知抬头里，证明通知说的是这一个任务。 */
const JOB_COMMAND = "sleep 5";

/** 第一个回合的收尾回答。 */
const FIRST_ANSWER = "已经在后台跑起来了。";

/** 第二个回合的回答；有这个回合，才说明通知唤醒了一次运行。 */
const SECOND_ANSWER = "后台任务跑完了。";

test("Job notice: a background job finishes → the notice wakes the idle session → the model answers again", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "job-notice" });
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

    // 5. 后台调用的行出现：工具真的跑过，才可能有这一行。
    await expect(
      page.getByRole("button", { name: /^Bash/u }).first()
    ).toBeVisible();

    // 6. 第一个回合结束在「任务已经起来了」这一步，任务本身还在跑。
    await expect(page.getByText(FIRST_ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(1);

    // 7. 任务结算后通知出现。它是独立的一块，不是用户气泡。
    const notice = page.getByRole("note", { name: NOTICE_MARKER });
    await expect(notice).toBeVisible();

    // 8. 通知带上了这个任务的输出、终态和命令本身：未读输出没超过内联上限，
    //    所以游标在这里被消费，模型不必再调 `job-output`。
    await expect(notice).toContainText(JOB_COMMAND);
    await expect(notice).toContainText(JOB_OUTPUT);
    await expect(notice).toContainText(JOB_STATUS);

    // 9. 通知里没有任何动作按钮：不能复制、不能重新生成，也不进输入框。
    await expect(notice.getByRole("button")).toHaveCount(0);

    // 10. 空闲会话被唤醒，第二个回合自己跑起来并收尾。
    await expect(page.getByText(SECOND_ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(2);

    // 请求序列是这一层唯一的硬证据：3 次流式请求——第一个回合要后台命令、
    // 第一个回合作答、被通知唤醒的那个回合作答。非流式请求只数「有」：完成
    // 通知本身也是一个 user 回合，标题生成会为它再问一次，而这一次问不问不
    // 是这条用例要证明的事。
    const streams = stack.fake.requests.filter((request) => request.stream);
    const titles = stack.fake.requests.filter((request) => !request.stream);
    expect(streams).toHaveLength(3);
    expect(titles.length).toBeGreaterThanOrEqual(1);
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
