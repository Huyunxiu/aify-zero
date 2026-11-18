/**
 * 桌面那条发件箱连接：拿到的帧怎么变成通知，通知弹出来之后怎么回执。
 *
 * 重连由 partysocket 负责，所以这里不重测它的退避；测的是它留给我们的那几件
 * 事：令牌进没进升级请求、连上就订阅、一次通知一次回执、平台不支持通知时不
 * 回执，以及服务端说读不懂我们的帧时不再重连。
 *
 * 两个替身：`electron` 的 Notification（主进程里没有窗口也弹不出来），`ws` 的
 * 连接（真的 TCP 连接只是让测试慢）。partysocket 是真的，所以「断线之后重新
 * 订阅」这条路径是它自己跑出来的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OutboxConnection } from "../src/outbox/connection";

/* oxlint-disable unicorn/prefer-event-target */

const electron = vi.hoisted(() => {
  type Shown = {
    readonly body: string;
    readonly title: string;
    click: (() => void) | undefined;
  };

  const shown: Shown[] = [];
  let supported = true;

  class Notification {
    readonly #options: { body?: string; title?: string };
    #click: (() => void) | undefined;

    static isSupported(): boolean {
      return supported;
    }

    constructor(options: { body?: string; title?: string }) {
      this.#options = options;
    }

    on(event: string, listener: () => void): void {
      if (event === "click") {
        this.#click = listener;
      }
    }

    show(): void {
      shown.push({
        body: this.#options.body ?? "",
        title: this.#options.title ?? "",
        click: this.#click,
      });
    }
  }

  return {
    Notification,
    reset: () => {
      shown.length = 0;
      supported = true;
    },
    setSupported: (value: boolean) => {
      supported = value;
    },
    shown,
  };
});

// @ts-expect-error -- the test only needs `Notification`, not the whole module
vi.mock(import("electron"), () => ({ Notification: electron.Notification }));

const ws = vi.hoisted(() => {
  const created: FakeWebSocket[] = [];

  class FakeWebSocket extends EventTarget {
    readonly address: string;
    readonly headers: Record<string, string> | undefined;
    readonly sent: string[] = [];
    binaryType = "blob";
    readyState = 0;

    constructor(
      address: string | URL,
      _protocols?: unknown,
      options?: { headers?: Record<string, string> }
    ) {
      super();
      this.address = String(address);
      this.headers = options?.headers;
      created.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = 3;
    }

    /** 服务端接受了升级。 */
    accept(): void {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }

    /** 服务端推来一帧文本。 */
    receive(payload: string): void {
      this.dispatchEvent(new MessageEvent("message", { data: payload }));
    }

    /** 连接断了；`code` 是服务端给的关闭码。 */
    drop(code: number): void {
      this.readyState = 3;
      this.dispatchEvent(
        Object.assign(new Event("close"), { code, reason: "" })
      );
    }
  }

  return { created, FakeWebSocket };
});

// @ts-expect-error -- the test only needs the constructor, not the whole module
vi.mock(import("ws"), () => ({ default: ws.FakeWebSocket }));

const DELIVERY = {
  body: "all tests pass",
  id: "outbox-1",
  sessionId: "session-1",
  title: "Fix the build",
  turnId: "turn-1",
};

const notify = (items: readonly unknown[]): string =>
  JSON.stringify({ data: { items }, type: "outbox.notify" });

/** 第 `index` 条连接；还没建出来就是测试写错了。 */
const socketAt = (index: number): InstanceType<typeof ws.FakeWebSocket> => {
  const socket = ws.created[index];

  if (socket === undefined) {
    throw new Error(`connection ${String(index)} was not created`);
  }

  return socket;
};

/**
 * 等一条连接建出来，返回它。
 *
 * 第一次连是立刻的，重连要等一个退避周期（一秒起），所以超时留到五秒。
 */
const waitForSocket = async (
  index: number
): Promise<InstanceType<typeof ws.FakeWebSocket>> => {
  await vi.waitFor(
    () => {
      expect(ws.created.length).toBeGreaterThan(index);
    },
    { interval: 20, timeout: 5000 }
  );

  return socketAt(index);
};

/** 某一帧解出来的对象。 */
const frameAt = (
  socket: InstanceType<typeof ws.FakeWebSocket>,
  index: number
): unknown => JSON.parse(socket.sent[index] ?? "null");

const connections: { stop(): void }[] = [];

const create = (
  options: {
    origin?: () => string | undefined;
    logs?: string[];
    opened?: string[];
  } = {}
): { connection: { stop(): void }; logs: string[]; opened: string[] } => {
  const logs = options.logs ?? [];
  const opened = options.opened ?? [];
  const connection = new OutboxConnection({
    log: (message) => logs.push(message),
    onOpenSession: (sessionId) => opened.push(sessionId),
    origin: options.origin ?? (() => "http://127.0.0.1:18086"),
    token: () => "token-1",
  });

  connections.push(connection);
  connection.start();

  return { connection, logs, opened };
};

describe(OutboxConnection, () => {
  beforeEach(() => {
    ws.created.length = 0;
    electron.reset();
  });

  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.stop();
    }
  });

  it("puts the token on the upgrade request and subscribes once open", async () => {
    create();

    const socket = await waitForSocket(0);

    expect(socket.address).toBe("ws://127.0.0.1:18086/api/ws");
    expect(socket.headers).toStrictEqual({ authorization: "Bearer token-1" });

    socket.accept();
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    expect(frameAt(socket, 0)).toStrictEqual({ type: "outbox.subscribe" });
  });

  it("shows each delivery, opens its session on click, then acknowledges", async () => {
    const { opened } = create();
    const socket = await waitForSocket(0);

    socket.accept();
    socket.receive(notify([DELIVERY]));

    await vi.waitFor(() => {
      expect(electron.shown).toHaveLength(1);
    });
    expect(electron.shown[0]).toMatchObject({
      body: "all tests pass",
      title: "Fix the build",
    });

    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(2);
    });
    expect(frameAt(socket, 1)).toStrictEqual({
      data: { ids: ["outbox-1"] },
      type: "outbox.ack",
    });

    electron.shown[0]?.click?.();
    expect(opened).toStrictEqual(["session-1"]);
  });

  it("keeps the connection alive on a frame it cannot read", async () => {
    const { logs } = create();
    const socket = await waitForSocket(0);

    socket.accept();
    socket.receive("{ not json");
    socket.receive(notify([DELIVERY]));

    await vi.waitFor(() => {
      expect(electron.shown).toHaveLength(1);
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("dropped a bad frame");
  });

  it("does not acknowledge when the platform shows no notification", async () => {
    electron.setSupported(false);
    create();

    const socket = await waitForSocket(0);
    socket.accept();
    socket.receive(notify([DELIVERY]));

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(electron.shown).toHaveLength(0);
    // 只发出过订阅那一帧：没弹出来就不盖章，那一行会自己过期。
    expect(socket.sent).toHaveLength(1);
  });

  it("subscribes again after the connection drops", async () => {
    create();

    const first = await waitForSocket(0);
    first.accept();
    first.drop(1006);

    const second = await waitForSocket(1);
    second.accept();

    await vi.waitFor(() => {
      expect(second.sent).toHaveLength(1);
    });
    expect(frameAt(second, 0)).toStrictEqual({ type: "outbox.subscribe" });
  });

  it("stops reconnecting when the server rejects a frame", async () => {
    const { logs } = create();

    const socket = await waitForSocket(0);
    socket.accept();
    socket.drop(1008);

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(ws.created).toHaveLength(1);
    expect(logs.some((line) => line.includes("rejected a frame"))).toBeTruthy();
  });

  it("waits quietly while the server has no origin yet", async () => {
    const address: { origin?: string } = {};
    const { logs } = create({ origin: () => address.origin });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    // 等 server 起来不是故障：不建连接，也不写日志。
    expect(ws.created).toHaveLength(0);
    expect(logs).toStrictEqual([]);

    address.origin = "http://127.0.0.1:18086";

    // 重连按退避来，所以这里要等过一个周期。
    await waitForSocket(0);
  });
});
