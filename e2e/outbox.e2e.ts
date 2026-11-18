/**
 * 发件箱：一次没人看着的运行落定之后，桌面那条连接收到通知，回执把行盖住。
 *
 * 这条用例穿过真实的 API 进程、运行器、发件箱表和 `/api/ws` 上的应用通道。
 * 桌面进程跑不进 Playwright，所以订阅、收通知、回执这三步由用例自己扮演那个
 * 唯一的订阅者；它说的是同一份协议（`@workspace/shared/ws-protocol`），所以
 * 它和桌面说的是同一种话。
 *
 * 会话由接口开、由接口跑：页面一收到 `run.end` 就把会话标成已读，而「有人看
 * 了」正是发件箱不该弹通知的理由。这一条要的是反面——没人在看，才有通知。
 */
import { expect, test } from "@playwright/test";
import type { AgentUserTurn } from "@workspace/agent-client";
import {
  encodeChannelMessage,
  OUTBOX_ACK_MESSAGE_TYPE,
} from "@workspace/shared/ws-protocol";
import type NodeWebSocket from "ws";

import { startStack, waitFor } from "./harness";
import type { Stack } from "./harness";
import {
  collect,
  OUTBOX_TIMEOUT_MS,
  readOutboxState,
  rpcClient,
  subscribe,
} from "./outbox-helpers";

/** 用例自己开的会话；没有页面碰它，所以没人会把「刚跑完」改成「已读」。 */
const SESSION_ID = "e2e-outbox-session";

/** 用户的那一句话。回合 id 由服务端起，用例不猜。 */
const TURN_ID = "e2e-outbox-turn";

/** 场景 `outbox` 里模型的回答；投递的正文就是它。 */
const ANSWER = "跑完了，结果在会话里。";

/** 会话标题：非流式那一次请求的回答。通知带着它，用户才知道是哪条会话。 */
const TITLE = "发件箱";

/** 同一条只推一次；等三个扫描周期看有没有第二批。 */
const QUIET_MS = 3000;

/** 一条用户回合，形状和页面发的那个一样；类型就是接口收的那个。 */
const userTurn = (): AgentUserTurn => {
  const now = Date.now();

  return {
    content: [
      {
        content: [{ createdAt: now, text: "跑这条后台的活", type: "text" }],
        createdAt: now,
        id: `${TURN_ID}-step`,
        status: "done",
        type: "user",
      },
    ],
    createdAt: now,
    id: TURN_ID,
    status: "done",
    type: "user",
  };
};

test("Outbox: a run nobody watched → the subscriber is notified → the ack stamps the row", async () => {
  let stack: Stack | undefined;
  let socket: NodeWebSocket | undefined;
  let failed = false;

  try {
    stack = await startStack({ scenario: "outbox" });
    const live = stack;

    // 1. 桌面那条连接先订阅，再让活跑起来。连接建立之前的行不补发：补一批
    //    旧通知比漏掉一条更烦人。
    socket = await subscribe(live);
    const batches = collect(socket);

    // 2. 订阅要在服务端真的登记上，后面每一步都假定有人在等。
    await waitFor(
      async () => {
        const current = await readOutboxState(live);

        return current.subscribed ? current : undefined;
      },
      "the dispatcher to see the subscriber",
      OUTBOX_TIMEOUT_MS
    );

    // 3. 一条没人看着的会话：接口开，接口跑。
    await rpcClient(live).session.createSession({
      model: { modelId: "fake-fast", providerId: "fake" },
      sessionId: SESSION_ID,
      turns: [userTurn()],
    });

    // 4. 回合落定、越过竞态余量之后，投递器把它推过来。
    const [delivery] = await waitFor(
      () => batches[0],
      "the outbox notification",
      OUTBOX_TIMEOUT_MS
    );

    if (!delivery) {
      throw new Error("the outbox notify carried no item");
    }

    expect(batches[0]).toHaveLength(1);
    // 正文取自那个回合的最后一段文字：它是「这次跑出了什么」的唯一证据。
    expect(delivery.body).toBe(ANSWER);
    expect(delivery.sessionId).toBe(SESSION_ID);
    expect(delivery.title).toBe(TITLE);
    expect(delivery.turnId.length).toBeGreaterThan(0);

    // 5. 弹完了，回执盖在那一行上。
    socket.send(
      encodeChannelMessage({
        data: { ids: [delivery.id] },
        type: OUTBOX_ACK_MESSAGE_TYPE,
      })
    );

    // 6. 只读状态把这件事说清楚：没有等着投的行，推过一条，有连接在等。
    const state = await waitFor(
      async () => {
        const current = await readOutboxState(live);

        return current.pending === 0 ? current : undefined;
      },
      "the delivery to be stamped",
      OUTBOX_TIMEOUT_MS
    );

    expect(state.pushed).toBe(1);
    expect(state.subscribed).toBe(true);
    expect(state.lastScanAt).not.toBeNull();

    // 7. 同一行只推一次：再等三个扫描周期，也没有第二批。
    await new Promise((resolve) => {
      setTimeout(resolve, QUIET_MS);
    });

    expect(batches).toHaveLength(1);
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
