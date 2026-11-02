import { afterEach, describe, expect, test, vi } from "vitest";

import { openChannel } from "../src/lib/channel";
import type { Channel } from "../src/lib/channel";
import { useChannelStore } from "../src/stores/channel";

/**
 * 客户端这一半的协议行为：地址从文档 origin 推出、每次 `open` 都发 hello、
 * 收到 world 交给回调、`send` 走同一条连接、遇到解析不了的帧就关掉。
 *
 * 浏览器环境用一个假 socket 替身；这里验证的是协议动作，不是网络。真实
 * 重连由 partysocket 负责，不在这里重复测。
 */

type Listener = (event: {
  readonly code?: number;
  readonly data?: unknown;
}) => void;

class FakeSocket {
  static readonly instances: FakeSocket[] = [];

  readonly sent: string[] = [];
  readonly closed: (number | undefined)[] = [];
  readonly url: string;
  readonly #listeners = new Map<string, Set<Listener>>();
  readyState = 0;
  binaryType = "blob";

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();

    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed.push(code);
    this.emit("close", { code: code ?? 1000 });
  }

  /** 模拟底层连接上的事件；`readyState` 跟着变，partysocket 靠它判断能不能发。 */
  emit(
    type: string,
    event: { readonly code?: number; readonly data?: unknown } = {}
  ): void {
    if (type === "open") {
      this.readyState = 1;
    }

    if (type === "close") {
      this.readyState = 3;
    }

    // partysocket 会用 `event.type` 重建事件，缺了它监听器就收不到。
    const payload = { ...event, type };

    for (const listener of this.#listeners.get(type) ?? []) {
      listener(payload);
    }
  }
}

const originalDocument = globalThis.document;
const originalWebSocket = globalThis.WebSocket;
const originalDesktop = (globalThis as { aifyDesktop?: unknown }).aifyDesktop;

const installBrowser = (): void => {
  FakeSocket.instances.length = 0;
  Reflect.deleteProperty(globalThis, "aifyDesktop");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { baseURI: "http://127.0.0.1:3000/" },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeSocket,
  });
};

const restoreBrowser = (): void => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: originalWebSocket,
  });
  Object.defineProperty(globalThis, "aifyDesktop", {
    configurable: true,
    value: originalDesktop,
  });
};

/** partysocket 在下一个宏任务里才建底层连接，这里等它出现。 */
const nextSocket = async (): Promise<FakeSocket> => {
  await vi.waitFor(() => {
    expect(FakeSocket.instances.length).toBeGreaterThan(0);
  });

  const socket = FakeSocket.instances.at(-1);

  if (socket === undefined) {
    throw new Error("no socket was created");
  }

  return socket;
};

const opened: Channel[] = [];

const open = (handlers: Parameters<typeof openChannel>[0]): Channel => {
  const channel = openChannel(handlers);

  opened.push(channel);

  return channel;
};

/** 每个用例之后收干净：关掉连接、清掉 store 状态、还原全局对象。 */
const cleanup = (): void => {
  for (const channel of opened.splice(0)) {
    channel.close();
  }

  useChannelStore.getState().disconnect();
  useChannelStore.setState({ lastMessage: undefined, status: "closed" });
  restoreBrowser();
};

describe("channel client", () => {
  afterEach(cleanup);
  test("dials the channel on the document origin", async () => {
    installBrowser();

    open({ onMessage: () => {} });

    const socket = await nextSocket();

    expect(socket.url).toBe("ws://127.0.0.1:3000/api/ws");
  });

  test("uses the address the desktop shell supplies", async () => {
    installBrowser();
    Object.defineProperty(globalThis, "aifyDesktop", {
      configurable: true,
      value: {
        channelUrl: () => Promise.resolve("ws://127.0.0.1:18086/api/ws"),
      },
    });

    open({ onMessage: () => {} });

    const socket = await nextSocket();

    // 地址里没有凭据：升级请求的令牌由桌面壳在发出前注入。
    expect(socket.url).toBe("ws://127.0.0.1:18086/api/ws");
  });

  test("sends hello as soon as the socket opens", async () => {
    installBrowser();

    open({ onMessage: () => {} });

    const socket = await nextSocket();

    socket.emit("open");

    expect(socket.sent).toStrictEqual(['{"type":"hello"}']);
  });

  test("hands a parsed world to the caller", async () => {
    installBrowser();

    const received: string[] = [];

    open({
      onMessage: (message) => {
        received.push(message.type);
      },
    });

    const socket = await nextSocket();

    socket.emit("open");
    socket.emit("message", { data: '{"type":"world"}' });

    expect(received).toStrictEqual(["world"]);
  });

  test("sends a caller message on the same connection", async () => {
    installBrowser();

    const channel = open({ onMessage: () => {} });
    const socket = await nextSocket();

    socket.emit("open");
    channel.send({ data: { n: 1 }, type: "ping" });

    expect(socket.sent).toStrictEqual([
      '{"type":"hello"}',
      '{"type":"ping","data":{"n":1}}',
    ]);
  });

  test("closes the socket on a malformed frame", async () => {
    installBrowser();

    open({ onMessage: () => {} });

    const socket = await nextSocket();

    socket.emit("message", { data: "not json" });

    expect(socket.closed).toStrictEqual([1008]);
  });

  test("reports the close code", async () => {
    installBrowser();

    const codes: number[] = [];

    const channel = open({
      onClose: (code) => {
        codes.push(code);
      },
      onMessage: () => {},
    });

    await nextSocket();
    channel.close();

    expect(codes).toContain(1000);
  });
});

describe("channel store", () => {
  afterEach(cleanup);
  test("connect reports the connection status", async () => {
    installBrowser();

    useChannelStore.getState().connect();

    const socket = await nextSocket();

    expect(useChannelStore.getState().status).toBe("closed");

    socket.emit("open");

    expect(useChannelStore.getState().status).toBe("open");
  });

  test("keeps the last message", async () => {
    installBrowser();

    useChannelStore.getState().connect();

    const socket = await nextSocket();

    socket.emit("open");
    socket.emit("message", { data: '{"type":"world"}' });

    expect(useChannelStore.getState().lastMessage).toStrictEqual({
      type: "world",
    });
  });

  test("sends through the shared connection", async () => {
    installBrowser();

    useChannelStore.getState().connect();

    const socket = await nextSocket();

    socket.emit("open");
    useChannelStore.getState().send({ type: "ping" });

    expect(socket.sent).toStrictEqual(['{"type":"hello"}', '{"type":"ping"}']);
  });

  test("disconnect closes the connection", async () => {
    installBrowser();

    useChannelStore.getState().connect();

    await nextSocket();
    useChannelStore.getState().disconnect();

    expect(useChannelStore.getState().status).toBe("closed");
  });

  test("ignores a send before connect", () => {
    installBrowser();

    useChannelStore.getState().send({ type: "ping" });

    expect(FakeSocket.instances).toHaveLength(0);
  });
});
