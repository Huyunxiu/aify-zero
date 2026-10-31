import type {
  AgentSteeringStep,
  EnqueueInboxInput,
  InboxMessage,
} from "@workspace/agent-client";

import type { AgentStore } from "../storage";

export type ApplySteeringInput = {
  sessionId: string;
  turnId: string;
  /** 当前运行的 id：写进 step 行，读取时用来隐藏尚未结束的 step。 */
  streamId: string;
  /** 本次准备领取的消息 id；只有仍然存在的行会被写入。 */
  messageIds: string[];
};

/**
 * 会话待发送消息的入口。
 *
 * 服务端用它入队、列队、取消；agent 在步边界用它领取 next-step 消息。真正的
 * 事务、顺序和幂等由 store 保证，这一层只表达“Inbox 能做什么”。
 */
export class AgentInbox {
  readonly #store: AgentStore;

  constructor(store: AgentStore) {
    this.#store = store;
  }

  enqueue(input: EnqueueInboxInput): Promise<InboxMessage> {
    return this.#store.insertInboxMessage(input);
  }

  list(sessionId: string): Promise<InboxMessage[]> {
    return this.#store.listInboxMessages(sessionId);
  }

  /** 只取下一步要应用的引导消息。 */
  listSteering(sessionId: string): Promise<InboxMessage[]> {
    return this.#store.listInboxMessages(sessionId, { placement: "next-step" });
  }

  cancel(sessionId: string, id: string): Promise<number> {
    return this.#store.deleteInboxMessages(sessionId, [id]);
  }

  clear(sessionId: string): Promise<number> {
    return this.#store.deleteInboxMessages(sessionId);
  }

  /**
   * 原子领取 next-step 消息，并把它们写成当前 assistant turn 的 steering step。
   *
   * 返回真正领取到的 step；空数组表示这些消息已被取消或被另一个调用者领走。
   */
  applySteeringSteps(input: ApplySteeringInput): Promise<AgentSteeringStep[]> {
    return this.#store.applySteeringSteps(input);
  }

  /** 回合结束后把残留的 next-step 提升为 next-turn。 */
  promoteStale(sessionId: string): Promise<number> {
    return this.#store.promoteStaleInboxMessages(sessionId);
  }
}
