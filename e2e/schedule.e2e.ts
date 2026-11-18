/**
 * 日程：模型排一个按周期重复的定时器，到点后会话被唤醒，而那一行还在。
 *
 * 和 timer 用例走同一条链路（工具 → 库 → 扫描 → 收件箱 → 唤醒 → 回合），差别
 * 只在收尾：跟进用完删行，日程把到期时刻推到下一次。用例从 `/timer/state` 读回
 * `pendingSchedules`，那是「还在」的直接证据——这一条断言是 timer 用例给不了的。
 *
 * 等的是一个墙钟时刻。`daily` 写的是当地「几点几分」，所以把目标定在十几秒之后
 * 的那个整分，等待就压到一分钟出头，而 300 秒的间隔下限不必动。
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "每天早上提醒我看一次构建";

/** 通知块的标签（`timerNotice.marker`）；日程和跟进共用同一块。 */
const NOTICE_MARKER = "Timer fired";

/** 场景里模型写下的备注；它到点原样回到正文里。 */
const NOTE = "看看今天的构建过了没有";

const FIRST_ANSWER = "日程排好了，我先停在这里。";

const SECOND_ANSWER = "到点了，我接着看。";

/** 目标时刻离「现在」至少这么远，第一次运行才来得及收尾。 */
const LEAD_MS = 20_000;

/** 到点要等到那个整分，加上扫描间隔和渲染，留足余量。 */
const NOTICE_TIMEOUT_MS = 120_000;

// 启动、一分钟出头的等待、两次运行。
test.setTimeout(210_000);

/**
 * 当地时间的下一个整分，至少 `LEAD_MS` 之后。
 * @returns `HH:MM`，正好是 `daily` 规则要的形状。
 */
const nextWallClockMinute = (): string => {
  const target = new Date(Date.now() + LEAD_MS);
  target.setSeconds(0, 0);

  if (target.getTime() < Date.now() + LEAD_MS) {
    target.setMinutes(target.getMinutes() + 1);
  }

  const hours = String(target.getHours()).padStart(2, "0");
  const minutes = String(target.getMinutes()).padStart(2, "0");

  return `${hours}:${minutes}`;
};

test("Schedule: a daily rule fires → the notice wakes the idle session → the row stays", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  const at = nextWallClockMinute();

  try {
    stack = await startStack({
      scenario: {
        name: "schedule",
        models: ["fake-fast"],
        rules: [
          // 标题生成走非流式，先把它分出去，免得吃掉对话的规则。
          { when: { stream: false }, answer: "日程" },
          {
            when: { stream: true },
            toolCall: {
              name: "schedule-set",
              args: {
                note: NOTE,
                recurrence: { type: "daily", at },
              },
            },
          },
          { when: { stream: true }, answer: FIRST_ANSWER },
          { when: { stream: true }, answer: SECOND_ANSWER },
        ],
      },
    });
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

    // 4. 发一句话，模型据此排日程。
    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(MESSAGE);
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();

    // 5. 第一个回合收尾，会话回到空闲，那一行已经落库。
    await expect(page.getByText(FIRST_ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(1);

    // 6. 到点之后通知出现在会话里，正文说得出规则和下一次。
    const notice = page.getByRole("note", { name: NOTICE_MARKER });
    await expect(notice).toBeVisible({ timeout: NOTICE_TIMEOUT_MS });
    await expect(notice).toContainText(NOTE);
    await expect(notice).toContainText(`daily ${at}`);
    await expect(notice).toContainText("Next:");

    // 7. 那一行还在：日程推进了到期时刻，没有像跟进那样删掉。
    const state: unknown = await fetch(
      `${stack.apiUrl}/api/openapi/timer/state`,
      { headers: { authorization: `Bearer ${stack.token}` } }
    ).then(async (response) => await response.json());

    if (typeof state !== "object" || state === null) {
      throw new TypeError("timer state is not an object");
    }

    expect("pendingSchedules" in state && state.pendingSchedules).toBe(1);

    // 8. 空闲会话被唤醒，第二个回合自己跑起来并收尾。
    await expect(page.getByText(SECOND_ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(2);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
