/**
 * 定时器：模型排一个跟进，到点后调度器把它换成收件箱里的一行，空闲的会话因此
 * 被唤醒。
 *
 * 这条用例穿过浏览器、本机 API、运行器、host 沙箱、定时器表和收件箱。模型侧由
 * 假供应商应答：先排一个 60 秒的定时器，停下；到点被唤醒后接着作答。
 *
 * 它真的等满一分钟。扫描间隔在 e2e 里降到 1 秒（`AIFY_TIMER_SCAN_MS`），但
 * 定时器的 60 秒下限不动——那是契约的一部分。
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "设一个定时器，一分钟后叫我";

/** 通知块的标签（`timerNotice.marker`）。界面语言走 i18n 默认值 en-US。 */
const NOTICE_MARKER = "Timer fired";

/** 场景里模型写下的备注；它到点原样回到正文里。 */
const NOTE = "看看部署好了没有";

/** 第一个回合的收尾回答：定时器排好了，然后停在这里。 */
const FIRST_ANSWER = "定时器设好了，我先停在这里。";

/** 第二个回合的回答；有这个回合，才说明到点唤醒了一次运行。 */
const SECOND_ANSWER = "到点了，我接着看。";

/** 到点要等满 60 秒，比默认的断言超时（20 秒）长。 */
const NOTICE_TIMEOUT_MS = 90_000;

// 启动、一分钟的等待、两次运行；比默认的 120 秒留一点余量。
test.setTimeout(150_000);

test("Timer: a follow-up fires → the notice wakes the idle session → the model answers again", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "timer" });
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

    // 5. 第一个回合结束在「定时器排好了」这一步，会话回到空闲。
    await expect(page.getByText(FIRST_ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(1);

    // 6. 一分钟之后，到点的定时器出现在会话里。它是独立的一块，不是用户气泡。
    const notice = page.getByRole("note", { name: NOTICE_MARKER });
    await expect(notice).toBeVisible({ timeout: NOTICE_TIMEOUT_MS });

    // 7. 正文带着模型当时写下的备注——那是它醒来时判断该做什么的依据。
    await expect(notice).toContainText(NOTE);

    // 8. 通知里没有任何动作按钮：不能复制、不能重新生成，也不进输入框。
    await expect(notice.getByRole("button")).toHaveCount(0);

    // 9. 空闲会话被唤醒，第二个回合自己跑起来并收尾。
    await expect(page.getByText(SECOND_ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(2);

    // 请求序列是这一层唯一的硬证据：3 次流式请求——排定时器、第一个回合作答、
    // 到点被唤醒后的作答。非流式只数「有」：标题生成走同一个供应商，问几次
    // 不是这条用例要证明的事。
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
