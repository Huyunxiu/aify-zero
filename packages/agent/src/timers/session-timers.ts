import type { InboxPayload } from "@workspace/agent-client";

import type { SessionTimers, TimerStore } from "./types";

/**
 * 把一个存储面绑到一个会话上。
 *
 * 工具拿到的就是这份视图：会话身份和起跑配置在这里固定下来，工具不该知道
 * 它们，也不该能替别的会话排定时器。起跑配置取的是**装配时**的模型——到期
 * 那次运行用它，因为进程重启之后内存里没有别的来源（ADR 0016）。
 * @param store - 定时器的存储面。
 * @param input.sessionId - 这个视图属于哪个会话。
 * @param input.payload - 到期那次运行要用的宿主配置。
 * @returns 只认这一个会话的定时器视图。
 */
export const bindSessionTimers = (
  store: TimerStore,
  { sessionId, payload }: { sessionId: string; payload: InboxPayload }
): SessionTimers => ({
  set: async (input) =>
    await store.insertTimer({
      sessionId,
      toolCallId: input.toolCallId,
      note: input.note,
      dueAt: input.dueAt,
      payload,
    }),

  list: async () => await store.listTimers(sessionId),

  cancel: async (id) => await store.cancelTimer(sessionId, id),
});
