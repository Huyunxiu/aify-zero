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
import {
  encodeChannelMessage,
  OUTBOX_ACK_MESSAGE_TYPE,
  OUTBOX_NOTIFY_MESSAGE_TYPE,
  OUTBOX_SUBSCRIBE_MESSAGE_TYPE,
  parseChannelMessage,
  parseOutboxNotify,
} from "@workspace/shared/ws-protocol";
import type { OutboxDelivery } from "@workspace/shared/ws-protocol";
import NodeWebSocket from "ws";
import type { RawData } from "ws";

import { startStack, waitFor } from "./harness";
import type { Stack } from "./harness";

/** 用例自己开的会话；没有页面碰它，所以没人会把「刚跑完」改成「已读」。 */
const SESSION_ID = "e2e-outbox-session";

/** 用户的那一句话。回合 id 由服务端起，用例不猜。 */
const TURN_ID = "e2e-outbox-turn";

/** 场景 `outbox` 里模型的回答；投递的正文就是它。 */
const ANSWER = "跑完了，结果在会话里。";

/** 会话标题：非流式那一次请求的回答。通知带着它，用户才知道是哪条会话。 */
const TITLE = "发件箱";

/** 竞态余量两秒加一个扫描周期；给到二十秒，坏的时候才像坏。 */
const NOTIFY_TIMEOUT_MS = 20_000;

/** 同一条只推一次；等三个扫描周期看有没有第二批。 */
const QUIET_MS = 3000;

/** 投递器的只读状态；和 `/outbox/state` 的响应同形。 */
type OutboxState = {
  readonly intervalMs: number;
  readonly lastScanAt: number | null;
  readonly lastSent: number;
  readonly pending: number;
  readonly pushed: number;
  readonly subscribed: boolean;
};

/**
 * 一次 RPC 调用。
 *
 * 入参和结果都包在 `json` 里——页面走的是同一条路，所以这里不另开一套。
 */
const rpc = async (
  stack: Stack,
  path: string,
  input: unknown
): Promise<unknown> => {
  const response = await fetch(`${stack.apiUrl}/api/rpc/${path}`, {
    body: JSON.stringify({ json: input }),
    headers: {
      authorization: `Bearer ${stack.token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `rpc ${path} failed: ${String(response.status)} ${await response.text()}`
    );
  }

  const body: unknown = await response.json();

  if (typeof body === "object" && body !== null && "json" in body) {
    return body.json;
  }

  return body;
};

/** 一条用户回合，形状和页面发的那个一样。 */
const userTurn = () => {
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

/** `ws` 交过来的帧数据可能是 Buffer、ArrayBuffer，也可能是一串 Buffer。 */
const rawText = (data: RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }

  return Buffer.from(data).toString("utf-8");
};

/** 连上应用通道并订阅；用例扮演的就是桌面主进程那一条连接。 */
const subscribe = async (stack: Stack): Promise<NodeWebSocket> => {
  const websocket = new NodeWebSocket(
    `${stack.apiUrl.replace("http", "ws")}/api/ws`,
    { headers: { authorization: `Bearer ${stack.token}` } }
  );

  await new Promise<void>((resolve, reject) => {
    websocket.once("open", resolve);
    websocket.once("error", reject);
  });

  websocket.send(encodeChannelMessage({ type: OUTBOX_SUBSCRIBE_MESSAGE_TYPE }));

  return websocket;
};

/** 收到的通知批次，按到达顺序；断言「只推一次」要靠它。 */
const collect = (websocket: NodeWebSocket): OutboxDelivery[][] => {
  const batches: OutboxDelivery[][] = [];

  websocket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      return;
    }

    const message = parseChannelMessage(rawText(data));

    if (message.type === OUTBOX_NOTIFY_MESSAGE_TYPE) {
      batches.push([...parseOutboxNotify(message.data).items]);
    }
  });

  return batches;
};

/** 读投递器的只读状态；排障的人走的也是这条路径。 */
const readState = async (stack: Stack): Promise<OutboxState> => {
  const response = await fetch(`${stack.apiUrl}/api/openapi/outbox/state`, {
    headers: { authorization: `Bearer ${stack.token}` },
  });

  if (!response.ok) {
    throw new Error(
      `outbox state failed: ${String(response.status)} ${await response.text()}`
    );
  }

  return (await response.json()) as OutboxState;
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
        const current = await readState(live);

        return current.subscribed ? current : undefined;
      },
      "the dispatcher to see the subscriber",
      NOTIFY_TIMEOUT_MS
    );

    // 3. 一条没人看着的会话：接口开，接口跑。
    await rpc(live, "session/createSession", {
      model: { modelId: "fake-fast", providerId: "fake" },
      sessionId: SESSION_ID,
      turns: [userTurn()],
    });

    // 4. 回合落定、越过竞态余量之后，投递器把它推过来。
    const [delivery] = await waitFor(
      () => batches[0],
      "the outbox notification",
      NOTIFY_TIMEOUT_MS
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
        const current = await readState(live);

        return current.pending === 0 ? current : undefined;
      },
      "the delivery to be stamped",
      NOTIFY_TIMEOUT_MS
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
