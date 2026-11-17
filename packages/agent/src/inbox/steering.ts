import { logger } from "@workspace/shared/logger";

/**
 * 一次会话的插话信号。
 *
 * 用户消息以 steering 交给正在跑的回合时触发一次；订阅者（例如正在等待任务
 * 的工具）据此结束自己的阻塞等待。它不是粘性信号：触发过后不再记住，下一次
 * 等待要重新订阅。
 */
export type SteeringSignal = {
  /**
   * 订阅下一次插话。
   * @param listener - 触发时调用一次。
   * @returns 注销函数。
   */
  subscribe(listener: () => void): () => void;
  /** 通知所有订阅者；监听器抛错会被隔离。 */
  notify(): void;
};

/** 建一个插话信号。 */
export const createSteeringSignal = (): SteeringSignal => {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      // 直接在集合上迭代：监听器在回调里注销自己是安全的，Set 不会访问已删项。
      for (const listener of listeners) {
        try {
          listener();
        } catch (error: unknown) {
          logger.warn(
            `steering: listener threw and was contained: ${String(error)}`
          );
        }
      }
    },
  };
};
