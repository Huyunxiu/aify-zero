import {
  encodeChannelMessage,
  OUTBOX_ACK_MESSAGE_TYPE,
  OUTBOX_NOTIFY_MESSAGE_TYPE,
  OUTBOX_SUBSCRIBE_MESSAGE_TYPE,
  parseChannelMessage,
  parseOutboxNotify,
} from "@workspace/shared/ws-protocol";
import type { OutboxNotification } from "@workspace/shared/ws-protocol";
import { Notification } from "electron";
import WebSocket from "ws";
import type { RawData } from "ws";

/** `ws` 的 OPEN 状态码；只比较数字，避免在类型层引入运行时值。 */
const OPEN = 1;

/** 重连的起点与上限：本地 server 通常一秒内就能连上。 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type OutboxNotifierOptions = {
  /** 当前 API server 的 origin；还没起来时是 `undefined`，那就等下一轮重试。 */
  origin: () => string | undefined;
  /** 机器级访问令牌。 */
  token: () => string;
  /** 用户点了通知，要把那个会话打开。 */
  onOpenSession: (sessionId: string) => void;
  log: (message: string) => void;
};

/**
 * 桌面主进程的通知连接。
 *
 * 它是唯一一条订阅发件箱的连接：页面自己那条不订阅，所以窗口开着和收进托盘
 * 不会各弹一次。连接断了就按退避重连；重连之后服务端从重连那一刻算起，不补发
 * 断线期间的结果。
 *
 * 通知弹出来之后才回执：`delivered_at` 回答的是「弹了没有」，不是「发出去了
 * 没有」。平台不支持通知时不回执，那一行会自然过期，而不是被记成送达。
 */
export class OutboxNotifier {
  readonly #options: OutboxNotifierOptions;

  #socket: WebSocket | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #delay = RECONNECT_MIN_MS;
  #stopped = true;

  constructor(options: OutboxNotifierOptions) {
    this.#options = options;
  }

  /** 开始连接；重复调用没有副作用。 */
  start(): void {
    if (!this.#stopped) {
      return;
    }

    this.#stopped = false;
    this.#connect();
  }

  /** 停止连接并取消重连。 */
  stop(): void {
    this.#stopped = true;

    if (this.#retry !== undefined) {
      clearTimeout(this.#retry);
      this.#retry = undefined;
    }

    this.#socket?.removeAllListeners();
    this.#socket?.close();
    this.#socket = undefined;
  }

  #connect(): void {
    const origin = this.#options.origin();

    if (origin === undefined) {
      this.#scheduleReconnect();

      return;
    }

    const url = new URL("/api/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.#options.token()}` },
    });
    this.#socket = socket;

    socket.on("open", () => {
      this.#delay = RECONNECT_MIN_MS;
      socket.send(
        encodeChannelMessage({ type: OUTBOX_SUBSCRIBE_MESSAGE_TYPE })
      );
    });

    socket.on("message", (data: RawData) => {
      this.#handleFrame(socket, data);
    });

    socket.on("error", (error: Error) => {
      this.#options.log(`outbox notifier failed: ${error.message}`);
    });

    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
      }

      this.#scheduleReconnect();
    });
  }

  #handleFrame(socket: WebSocket, data: RawData): void {
    let message: ReturnType<typeof parseChannelMessage>;

    try {
      message = parseChannelMessage(
        Buffer.from(data as ArrayBuffer).toString()
      );
    } catch (error) {
      this.#options.log(
        `outbox notifier dropped a bad frame: ${error instanceof Error ? error.message : String(error)}`
      );

      return;
    }

    if (message.type !== OUTBOX_NOTIFY_MESSAGE_TYPE) {
      return;
    }

    let items: readonly OutboxNotification[];

    try {
      ({ items } = parseOutboxNotify(message.data));
    } catch (error) {
      this.#options.log(
        `outbox notifier dropped a bad notify: ${error instanceof Error ? error.message : String(error)}`
      );

      return;
    }

    const delivered = this.#show(items);

    if (delivered.length > 0 && socket.readyState === OPEN) {
      socket.send(
        encodeChannelMessage({
          data: { ids: delivered },
          type: OUTBOX_ACK_MESSAGE_TYPE,
        })
      );
    }
  }

  /** 弹一批通知，返回真的弹出来的那些 id。 */
  #show(items: readonly OutboxNotification[]): string[] {
    if (!Notification.isSupported()) {
      this.#options.log(
        "outbox notifier skipped: notifications are unsupported"
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
          `outbox notifier could not show ${item.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return delivered;
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#retry !== undefined) {
      return;
    }

    const delay = this.#delay;
    this.#delay = Math.min(this.#delay * 2, RECONNECT_MAX_MS);

    this.#retry = setTimeout(() => {
      this.#retry = undefined;

      if (!this.#stopped) {
        this.#connect();
      }
    }, delay);
    // 一条重连计时器不该拖住退出。
    this.#retry.unref?.();
  }
}
