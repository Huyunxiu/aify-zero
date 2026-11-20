/// <reference lib="dom" />
// 根 tsconfig 只带 ESNext 库；这个文件在 page.evaluate 里碰 document，
// 所以单独引入 DOM 类型。
/**
 * 发件箱：页面看不见时跑完的回合，仍然要弹系统通知。
 *
 * 桌面「关窗」不是销毁页面，只是 `hide()`：页面还在、还连着会话事件，也会在
 * 回合落定时把「已读」写回去。可人已经看不见屏幕了，这一下不该算「有人看
 * 了」——发件箱正是靠这个状态决定弹不弹。
 *
 * 桌面进程跑不进 Playwright，所以这里的连接仍然由用例扮演。页面这一侧用慢
 * 回答场景，好在运行落定前把文档的 `visibilityState` 切成 hidden。这是页面
 * 可见性的替身，不是 Electron `hide()` 的证明；平台事实由
 * `docs/development/desktop-and-api.md` 里那条独立探针确认。
 */
import { expect, test } from "@playwright/test";
import type NodeWebSocket from "ws";

import { PROJECT_NAME, startStack, waitFor } from "./harness";
import type { Stack } from "./harness";
import {
  collect,
  OUTBOX_TIMEOUT_MS,
  readOutboxState,
  rpcClient,
  subscribe,
} from "./outbox-helpers";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const MESSAGE = "Run a job that takes a moment";

/** 慢回答场景里第一个流式回答的正文；通知的正文就是它。 */
const ANSWER = "Got the first message.";

/** 起页、建项目、跑一个三秒的回合；比默认的 120 秒留一点余量。 */
test.setTimeout(150_000);

test("Outbox: a turn that settles while the page is hidden still notifies", async ({
  page,
}) => {
  let stack: Stack | undefined;
  let socket: NodeWebSocket | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "slow-answer" });
    const live = stack;
    const client = rpcClient(live);

    // 1. 桌面那条连接先订阅，再让活跑起来。
    socket = await subscribe(live);
    const batches = collect(socket);
    await waitFor(
      async () => {
        const state = await readOutboxState(live);
        return state.subscribed ? true : undefined;
      },
      "the dispatcher to see the subscriber",
      OUTBOX_TIMEOUT_MS
    );

    // 2. 用 server 打印的登录链接进去，建项目、开会话。
    await page.goto(live.loginUrl);
    await expect(page.getByText("No projects", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New project" }).click();
    await page.getByPlaceholder("My project").fill(PROJECT_NAME);
    await page
      .getByPlaceholder("/Users/me/code/my-project")
      .fill(live.projectDir);
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByText(PROJECT_NAME)).toBeVisible();

    await page.getByText(PROJECT_NAME).first().hover();
    await page
      .getByRole("button", { name: "New session in this project" })
      .click();

    // 3. 发一句话，然后在它跑完之前把页面切到 hidden。
    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(MESSAGE);
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();

    // 页面读的是 `document.visibilityState`；回答要三秒才开头，来得及。
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // 4. 回合在隐藏状态下落定；没人看着，系统通知应该推过来。
    const [delivery] = await waitFor(
      () => batches[0],
      "the outbox notification",
      OUTBOX_TIMEOUT_MS
    );

    if (!delivery) {
      throw new Error("the outbox notify carried no item");
    }

    expect(delivery.body).toBe(ANSWER);
    expect(batches[0]).toHaveLength(1);

    // 5. 用例自己的客户端也走同一套 RPC，能读到这条会话；确认它不是被页面
    //    悄悄标成已读后才碰巧出现的。
    const sessions = await client.session.listSessions({
      limit: 10,
    });
    const session = sessions.sessions.find(
      (row) => row.id === delivery.sessionId
    );
    expect(session?.status).toBe("done");

    // 6. 回到前台：页面补做标记已读，侧栏的勾才会消失。
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(
      async () => {
        const current = await client.session.listSessions({
          limit: 10,
        });
        return current.sessions.find((row) => row.id === delivery.sessionId)
          ?.status === "idle"
          ? true
          : undefined;
      },
      "the session to be marked read when the window is visible again",
      OUTBOX_TIMEOUT_MS
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    socket?.close();
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
