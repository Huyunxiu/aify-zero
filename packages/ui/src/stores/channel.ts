import { logger } from "@workspace/shared/logger";
import type { ChannelMessage } from "@workspace/shared/ws-protocol";
import { create } from "zustand";

import { openChannel } from "../lib/channel";
import type { Channel } from "../lib/channel";

/** 通道当前是否连得上。partysocket 会在断开后自己重连，所以这是瞬时状态。 */
export type ChannelStatus = "open" | "closed";

interface ChannelState {
  /** 最近一次连接状态。 */
  readonly status: ChannelStatus;
  /** 服务端推来的最后一条消息。 */
  readonly lastMessage: ChannelMessage | undefined;
  /** 建连；重复调用不做任何事。 */
  connect: () => void;
  /** 关闭并停止重连。 */
  disconnect: () => void;
  /** 发一条消息；通道没建时记一条告警并丢弃。 */
  send: (message: ChannelMessage) => void;
}

/**
 * 连接本身不放进 state：它不可序列化，也不需要触发重渲染。
 *
 * 放在模块作用域还有一个原因：发送方可能不是 React 组件（例如某个 store 的
 * action），它们用 `useChannelStore.getState().send()` 就够了，不必经过渲染树。
 */
let channel: Channel | undefined;

/**
 * 应用通道的全局入口。
 *
 * 整个应用只有一条通道：`connect()` 在应用启动时调用一次，之后任何地方都从
 * 这里 `send()`，或者订阅 `status` / `lastMessage`。
 */
export const useChannelStore = create<ChannelState>((set) => ({
  lastMessage: undefined,
  status: "closed",

  connect: () => {
    if (channel !== undefined) {
      return;
    }

    try {
      channel = openChannel({
        onClose: () => {
          set({ status: "closed" });
        },
        onMessage: (message) => {
          set({ lastMessage: message });
        },
        onOpen: () => {
          set({ status: "open" });
        },
      });
    } catch (error) {
      logger.error("[channel] not opened", error);
    }
  },

  disconnect: () => {
    const current = channel;

    channel = undefined;
    // partysocket 的 close() 会同步派发 close 事件，状态由 onClose 落定。
    current?.close();
  },

  send: (message) => {
    if (channel === undefined) {
      logger.warn("[channel] send ignored: channel is not connected");

      return;
    }

    channel.send(message);
  },
}));
