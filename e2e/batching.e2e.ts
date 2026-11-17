/**
 * 排队的两条消息由一次运行回答。
 *
 * 用例要一个「运行还没结束」的窗口：没有静默窗口，第一条消息会立刻起跑，后两条
 * 只有在第一次运行还在跑时排进队列，才会落在同一次领取里。所以现场的剧本是
 * `slow-answer`，首块延迟 3 秒。
 *
 * 断言分两层：界面上是三条用户消息、两个回合、队列清空；假供应商那边是两次流式
 * 请求。只数界面的 `Finished` 不够——它证明用户看到一条回复，不证明只跑了一次
 * 模型循环。
 */
import { expect, test } from "@playwright/test";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const SENT = "先处理这一条";
const QUEUED_FIRST = "顺便看第二个";
const QUEUED_SECOND = "还有第三个";

const FIRST_ANSWER = "第一句收到。";
const SECOND_ANSWER = "两条都收到了。";

test("Queued messages are answered by one run", async ({ page }) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "slow-answer" });
    const { loginUrl } = stack;

    await page.goto(loginUrl);
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
    await page.keyboard.type(SENT);
    await page.getByRole("button", { name: "Send" }).click();

    // 运行中的投递方式按钮只在生成时渲染；它出现，说明第一次运行已经在跑。
    const queueMode = page.getByRole("button", { name: "Queue", exact: true });
    await expect(queueMode).toBeVisible();
    await queueMode.click();

    // 两条都选「排队」，所以都不会插进当前回合。
    for (const message of [QUEUED_FIRST, QUEUED_SECOND]) {
      await composer.click();
      await page.keyboard.type(message);
      await page
        .getByRole("button", { name: "Send as queued message" })
        .click();
    }

    // 两条都在队列里，一条都没进正文。
    await expect(page.getByText("2 pending", { exact: true })).toBeVisible();

    // 第一次运行按自己的剧本结束，一条回答。
    await expect(page.getByText(FIRST_ANSWER)).toBeVisible();

    // 第二次运行领走两条，只回答一条。
    await expect(page.getByText(SECOND_ANSWER)).toBeVisible();

    // 两个回合：一条一条地跑会是三个。
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(2);

    // 三条用户消息都在正文里，顺序就是发送顺序。
    const log = page.getByRole("log");
    await expect(log.getByText(SENT)).toBeVisible();
    await expect(log.getByText(QUEUED_FIRST)).toBeVisible();
    await expect(log.getByText(QUEUED_SECOND)).toBeVisible();

    // 队列已经空了，不再有等待提示。
    await expect(page.getByText("2 pending", { exact: true })).toHaveCount(0);

    // 这一层唯一的硬证据：每次运行恰好一次流式请求，标题只生成一次。第二次
    // 运行不再问标题，说明第一次运行把标题写进了会话行。
    const streams = stack.fake.requests.filter((request) => request.stream);
    const titles = stack.fake.requests.filter((request) => !request.stream);
    expect(streams).toHaveLength(2);
    expect(titles).toHaveLength(1);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
