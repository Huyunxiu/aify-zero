import type { JobEvent, JobEventFilter, JobEventListener } from "./types";

/** 一个登记好的监听器，连同它声明的过滤条件。 */
type Subscription = {
  filter: JobEventFilter;
  listener: JobEventListener;
};

/**
 * 事件路由：订阅按过滤条件登记，每次提交对每个匹配的监听器各派发一次，
 * 并隔离单个监听器的异常，避免观察者破坏已经完成的提交。
 */
export class JobEventHub {
  readonly #subscriptions = new Set<Subscription>();
  readonly #warn: (message: string) => void;

  /**
   * @param warn - 监听器抛错时的落点。
   */
  constructor(warn: (message: string) => void) {
    this.#warn = warn;
  }

  /**
   * 登记一个监听器。
   * @param filter - 投递哪些拥有者的事件。
   * @param listener - 每个匹配事件调用一次。
   * @returns 注销该监听器的函数。
   */
  subscribe(filter: JobEventFilter, listener: JobEventListener): () => void {
    const subscription: Subscription = { filter, listener };
    this.#subscriptions.add(subscription);
    return (): void => {
      this.#subscriptions.delete(subscription);
    };
  }

  /**
   * 把一个事件投递给所有匹配的订阅。
   *
   * `{ owner }` 订阅收到该会话的任务和所有无主任务：无主任务是任何调用方都
   * 看得见的集合，所以 `owner` 为 `undefined` 时不能过滤掉。
   * @param event - 要投递的事件。
   * @param owner - 任务的确切拥有者；无主任务传 `undefined`。
   */
  emit(event: JobEvent, owner?: string): void {
    for (const { filter, listener } of this.#subscriptions) {
      if ("owner" in filter && owner !== undefined && owner !== filter.owner) {
        continue;
      }
      try {
        listener(event);
      } catch (error: unknown) {
        this.#warn(
          `jobs: event listener threw on ${event.type}: ${String(error)}`
        );
      }
    }
  }
}
