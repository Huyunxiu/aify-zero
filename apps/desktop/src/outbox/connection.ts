import { frameText } from "@workspace/shared/ws-frame";
import {
  encodeChannelMessage,
  OUTBOX_ACK_MESSAGE_TYPE,
  OUTBOX_NOTIFY_MESSAGE_TYPE,
  OUTBOX_SUBSCRIBE_MESSAGE_TYPE,
  parseChannelMessage,
  parseOutboxNotify,
  WEBSOCKET_OPEN,
} from "@workspace/shared/ws-protocol";
import type { OutboxDelivery } from "@workspace/shared/ws-protocol";
import { Notification } from "electron";
import ReconnectingWebSocket from "partysocket/ws";
import WebSocket from "ws";

/** 重连的起点与上限：本地 server 通常一秒内就能连上。 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * 协议已经不同步的关闭码。
 *
 * 这条连接只发两种帧，两种都由这里编码；服务端说读不懂，就是我们写错了。重连
 * 只会把同一串坏帧再送一遍，所以这种关闭不再重试。
 */
const UNRECOVERABLE_CLOSE = 1008;

export type OutboxConnectionOptions = {
  /** 当前 API server 的 origin；还没起来时是 `undefined`，那就等下一轮重试。 */
  origin: () => string | undefined;
  /** 机器级访问令牌。 */
  token: () => string;
  /** 用户点了通知，要把那个会话打开。 */
  onOpenSession: (sessionId: string) => void;
  log: (message: string) => void;
};

/** partysocket 只按这两个参数构造连接，所以这个类也只收这两个。 */
type SocketConstructor = new (
  address: string | URL,
  protocols?: string | string[]
) => WebSocket;

/**
 * 把访问令牌塞进升级请求。
 *
 * partysocket 只接受一个 WebSocket 构造器，不接受请求头；Node 的全局
 * `WebSocket` 又改不了请求头。所以给它一个 `ws` 的子类，令牌在构造时现取——
 * 令牌文件换了，下一次重连就跟上。
 *
 * @param token - 取令牌的函数。
 * @returns 可以直接交给 partysocket 的构造器。
 */
const authorizedSocket = (token: () => string): SocketConstructor =>
  class AuthorizedWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, {
        headers: { authorization: `Bearer ${token()}` },
      });
    }
  };

/**
 * 桌面主进程的发件箱连接。
 *
 * 它是唯一一条订阅发件箱的连接：页面自己那条不订阅，所以窗口开着和收进托盘
 * 不会各弹一次。断线与重连交给 partysocket（页面那条通道用的是同一个）：连上
 * 就重新订阅，服务端从重连那一刻算起，不补发断线期间的结果。
 *
 * 通知弹出来之后才回执：`delivered_at` 回答的是「弹了没有」，不是「发出去了
 * 没有」。平台不支持通知时不回执，那一行会自然过期，而不是被记成送达。
 */
export class OutboxConnection {
  readonly #options: OutboxConnectionOptions;

  #socket: ReconnectingWebSocket | undefined;

  constructor(options: OutboxConnectionOptions) {
    this.#options = options;
  }

  /** 开始连接；重复调用没有副作用。 */
  start(): void {
    if (this.#socket !== undefined) {
      return;
    }

    const socket = new ReconnectingWebSocket(
      () => this.#channelUrl(),
      undefined,
      {
        WebSocket: authorizedSocket(this.#options.token),
        // 默认是三秒起步、十秒封顶、每次乘一点三；这里要的是一秒起步、三十秒
        // 封顶、每次翻倍——内置 server 重启通常几秒内就好。
        maxReconnectionDelay: RECONNECT_MAX_MS,
        minReconnectionDelay: RECONNECT_MIN_MS,
        reconnectionDelayGrowFactor: 2,
        shouldReconnectOnClose: (event) => event.code !== UNRECOVERABLE_CLOSE,
      }
    );
    this.#socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        encodeChannelMessage({ type: OUTBOX_SUBSCRIBE_MESSAGE_TYPE })
      );
    });

    socket.addEventListener("message", (event) => {
      this.#handleFrame(socket, frameText(event.data));
    });

    socket.addEventListener("error", (event) => {
      // server 还没起来：这是等待，不是故障，启动那条日志会说清楚。
      if (this.#options.origin() === undefined) {
        return;
      }

      this.#options.log(`outbox connection failed: ${event.message}`);
    });

    socket.addEventListener("close", (event) => {
      if (event.code === UNRECOVERABLE_CLOSE) {
        this.#options.log(
          `outbox connection stopped: the server rejected a frame (${String(event.code)})`
        );
      }
    });
  }

  /** 停止连接并取消重连。 */
  stop(): void {
    this.#socket?.close();
    this.#socket = undefined;
  }

  /**
   * 应用通道的地址。
   *
   * 每次重连都重新问一次 origin：内置 server 换了端口，下一次重连自动跟上。还
   * 没就绪时抛错——partysocket 把拿不到地址当成一次失败，按退避再来。
   */
  #channelUrl(): string {
    const origin = this.#options.origin();

    if (origin === undefined) {
      throw new Error("the API server is not ready");
    }

    const url = new URL("/api/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    return url.href;
  }

  /** 一条文本帧。坏帧只记一行：连接还能用，让它继续。 */
  #handleFrame(socket: ReconnectingWebSocket, text: string): void {
    let message: ReturnType<typeof parseChannelMessage>;

    try {
      message = parseChannelMessage(text);
    } catch (error) {
      this.#options.log(
        `outbox connection dropped a bad frame: ${error instanceof Error ? error.message : String(error)}`
      );

      return;
    }

    if (message.type !== OUTBOX_NOTIFY_MESSAGE_TYPE) {
      return;
    }

    let items: readonly OutboxDelivery[];

    try {
      ({ items } = parseOutboxNotify(message.data));
    } catch (error) {
      this.#options.log(
        `outbox connection dropped a bad delivery: ${error instanceof Error ? error.message : String(error)}`
      );

      return;
    }

    const delivered = this.#show(items);

    if (delivered.length > 0 && socket.readyState === WEBSOCKET_OPEN) {
      socket.send(
        encodeChannelMessage({
          data: { ids: delivered },
          type: OUTBOX_ACK_MESSAGE_TYPE,
        })
      );
    }
  }

  /** 弹一批通知，返回真的弹出来的那些 id。 */
  #show(items: readonly OutboxDelivery[]): string[] {
    if (!Notification.isSupported()) {
      this.#options.log(
        "outbox connection skipped: notifications are unsupported"
      );

      return [];
    }

    const delivered: string[] = [];

    for (const item of items) {
      try {
        const notification = new Notification({
          body: item.body,
          title: item.title,
        });
        notification.on("click", () => {
          this.#options.onOpenSession(item.sessionId);
        });
        notification.show();
        delivered.push(item.id);
      } catch (error) {
        this.#options.log(
          `outbox connection could not show ${item.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return delivered;
  }
}
