/**
 * 侧栏按最后活动排序，并显示那条活动距今多久。
 *
 * 这条用例穿过的接缝是「服务端在回合边界写最后活动 ↔ 侧栏把它画出来并按它排序」。
 * 模型侧由假供应商应答，所以三个回合的输入都是确定的。
 *
 * 断言只落在用户看得见的东西上：文字，以及这些文字在页面上的上下位置。类名与 DOM
 * 结构不在断言范围内。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

/** 场景给两次标题生成两个不同的回答，所以这两段文字各自只属于一个会话。 */
const FIRST = "Session one";
const SECOND = "Session two";

test("Session list: the session used last comes first and shows when it was used", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "session-order" });
    await page.goto(stack.loginUrl);

    // 顶部那颗「新建会话」按钮是唯一带文字的：会话分组标题上的同名入口只有一个
    // 图标，字在 `aria-label` 里，`getByText` 取不到它。
    const newSession = page.getByText("New Session", { exact: true });

    // 1. 会话甲的第一个回合。标题在回合开始后由后台生成，落库后侧栏与页面头部各
    //    显示一处，所以这里等到它出现即可。
    await newSession.click();
    await sendAndSettle(page, "First message");
    await expect(page.getByText(FIRST, { exact: true }).first()).toBeVisible();

    // 2. 会话乙的第一个回合。此刻乙既是最晚创建、也是最晚活动的。
    //
    //    先跨过一个整秒：`created_at` 是整秒精度，两个会话落在同一秒的话，按创建
    //    时刻排也是同一个顺序，最后那条断言就分辨不出排序用的是哪一列。
    await page.waitForTimeout(1100);
    await newSession.click();
    await sendAndSettle(page, "Second message");
    await expect(page.getByText(SECOND, { exact: true }).first()).toBeVisible();

    // 3. 回到甲再跑一个回合。现在甲更早创建、却更晚活动：按创建时刻排它该在下面，
    //    按最后活动排它必须回到第一。
    //
    //    这一步同时是「回到旧会话继续用」这个真实动作：切回来时不需要刷新，甲的
    //    第一个回合就该在屏幕上。
    await page.getByText(FIRST, { exact: true }).click();
    await expect(
      page.getByText("First message", { exact: true })
    ).toBeVisible();
    await sendAndSettle(page, "Third message");

    // 4. 落到一个还没有标题的新会话，让两个标题在整页上各自只剩侧栏那一处。
    //    不要跳过这一步：会话页头部也显示标题，停在甲里会让 `会话甲` 匹配两处，
    //    于是顺序断言比的是「头部 vs 侧栏」，永远为真。
    await newSession.click();
    await expect(page.getByText("Untitled", { exact: true })).toBeVisible();

    // 5. 两行刚跑完，所以都显示同一个档位。位置比较用的是文字节点自身的坐标：
    //    顺序就是用户看到的顺序。
    await expect(page.getByText(FIRST, { exact: true })).toHaveCount(1);
    await expect(page.getByText(SECOND, { exact: true })).toHaveCount(1);
    await expect(page.getByText("Just now", { exact: true })).toHaveCount(2);

    const firstRow = await page.getByText(FIRST, { exact: true }).boundingBox();
    const secondRow = await page
      .getByText(SECOND, { exact: true })
      .boundingBox();

    expect(firstRow).not.toBeNull();
    expect(secondRow).not.toBeNull();
    expect(firstRow?.y).toBeLessThan(secondRow?.y ?? Number.POSITIVE_INFINITY);

    // 请求序列是这一层唯一的硬证据：三次流式回答对应三个回合，两次非流式的标题
    // 请求对应两个会话。
    expect(
      stack.fake.requests.filter((request) => request.stream)
    ).toHaveLength(3);
    expect(
      stack.fake.requests.filter((request) => !request.stream)
    ).toHaveLength(2);
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
 * 按「现在有几个 `Finished`」加一等，而不是等一个绝对数：同一条用例里有的会话是从
 * 空会话记录开始的，有的是回访后才取到历史的，各自渲染出来的份数不同。
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
