/**
 * 应用通道的客户端。
 *
 * 协议见 `@workspace/shared/ws-protocol`：消息是 `{ type, data }` 的 JSON。
 * 连接建立后立刻发 `hello`，服务端回 `world` —— 这是协议的握手，也是页面
 * 确认通道可用的方式。
 *
 * 连接用 partysocket 的重连 WebSocket：断线后它自己按退避重连，`open` 会再
 * 来一次，所以握手写在 `open` 监听里，每次重连都会重新握手。
 */
import {
  encodeChannelMessage,
  HELLO_MESSAGE_TYPE,
  parseChannelMessage,
} from "@workspace/shared/ws-protocol";
import type { ChannelMessage } from "@workspace/shared/ws-protocol";
import ReconnectingWebSocket from "partysocket/ws";

/**
 * 把一条逻辑路径解析成当前文档所属的 WebSocket 地址。
 *
 * WebSocket 的凭据由同源代理注入，所以地址必须落在文档自己的 origin 上：
 * 浏览器打到 Vite 代理，桌面由壳决定文档源。页面不需要知道 API 在哪个端口。
 *
 * @param path - 相对文档根的逻辑路径，例如 `api/ws`。
 * @returns 可以交给 `new WebSocket()` 的绝对地址。
 * @throws {Error} 文档源不是 http(s) 时——桌面壳必须先告诉页面 API 的 origin。
 */
export const resolveWebSocketUrl = (path: string): string => {
  const url = new URL(path, document.baseURI);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // aify-app:// 没有对应的 WebSocket scheme。
    throw new Error(
      `WebSocket transport needs an http(s) base, got ${url.protocol}`
    );
  }

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.href;
};

/** 通道的回调。 */
export interface ChannelHandlers {
  /** 收到一条合法消息。 */
  readonly onMessage: (message: ChannelMessage) => void;
  /** 握手发出去了，通道可用。每次重连都会再调用一次。 */
  readonly onOpen?: () => void;
  /** 连接断开；参数是关闭码。partysocket 随后会自动重连。 */
  readonly onClose?: (code: number) => void;
}

/** 一条打开的通道。 */
export interface Channel {
  /** 主动关闭，并停止自动重连。 */
  close(): void;
  /** 发一条消息；连接还没开时 partysocket 会排队，连上后补发。 */
  send(message: ChannelMessage): void;
}

/** 桌面壳在 preload 注入的通道地址；浏览器里没有这个对象。 */
interface DesktopBridge {
  readonly channelUrl?: () => Promise<string>;
}

/**
 * 通道地址。
 *
 * 浏览器：同源相对路径，令牌由代理在升级请求上注入。
 * 桌面：文档源是 `aify-app://`，没有 WebSocket scheme，地址由主进程给出；
 * 令牌同样由主进程在升级请求上注入，地址里不含凭据。
 *
 * partysocket 每次重连都会重新解析一次，所以主进程换了 origin 之后，下一次
 * 重连自动跟上。
 */
const resolveChannelUrl = async (): Promise<string> => {
  const bridge = (globalThis as { aifyDesktop?: DesktopBridge }).aifyDesktop;

  if (bridge?.channelUrl !== undefined) {
    return await bridge.channelUrl();
  }

  return resolveWebSocketUrl("api/ws");
};

/**
 * 打开应用通道并完成握手。
 *
 * 一条解析不了的服务端消息会关掉连接：协议已经不同步，继续读下去只会拿到
 * 更多的错。`close()` 同时停掉重连，所以这种关闭是终局。
 *
 * @param handlers - 消息、打开与关闭回调。
 * @returns 可以发送和关闭的句柄。
 */
export const openChannel = ({
  onMessage,
  onOpen,
  onClose,
}: ChannelHandlers): Channel => {
  const socket = new ReconnectingWebSocket(resolveChannelUrl);

  socket.addEventListener("open", () => {
    socket.send(encodeChannelMessage({ type: HELLO_MESSAGE_TYPE }));
    onOpen?.();
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      socket.close(1003, "text messages required");

      return;
    }

    try {
      onMessage(parseChannelMessage(event.data));
    } catch {
      socket.close(1008, "invalid message");
    }
  });

  socket.addEventListener("close", (event) => {
    onClose?.(event.code);
  });

  return {
    close: () => {
      socket.close();
    },
    send: (message) => {
      socket.send(encodeChannelMessage(message));
    },
  };
};
