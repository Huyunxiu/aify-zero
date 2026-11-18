import type { InboxPayload } from "@workspace/agent-client";

import { nextOccurrence, resolveRecurrence } from "./recurrence";
import type { SessionTimers, TimerStore } from "./types";

/**
 * 把一个存储面绑到一个会话上。
 *
 * 工具拿到的就是这份视图：会话身份、起跑配置和默认时区在这里固定下来，工具不该
 * 知道它们，也不该能替别的会话排定时器。起跑配置取的是**装配时**的模型——到期
 * 那次运行用它，因为进程重启之后内存里没有别的来源（ADR 0016）。默认时区同理：
 * 日历规则没写时区时用它，写进去之后这一行就不再跟随设置（ADR 0018）。
 * @param store - 定时器的存储面。
 * @param input.sessionId - 这个视图属于哪个会话。
 * @param input.payload - 到期那次运行要用的宿主配置。
 * @param input.timeZone - 日历规则缺省使用的 IANA 时区。
 * @returns 只认这一个会话的定时器视图。
 */
export const bindSessionTimers = (
  store: TimerStore,
  {
    sessionId,
    payload,
    timeZone,
  }: { sessionId: string; payload: InboxPayload; timeZone: string }
): SessionTimers => ({
  set: async (input) =>
    await store.insertTimer({
      sessionId,
      toolCallId: input.toolCallId,
      note: input.note,
      dueAt: input.dueAt,
      recurrence: null,
      payload,
    }),

  setSchedule: async ({ toolCallId, note, recurrence }) => {
    const rule = resolveRecurrence(recurrence, timeZone);
    const now = Date.now();

    return await store.insertTimer({
      sessionId,
      toolCallId,
      note,
      // 第一次触发就是规则在当下之后的那一次；没有「先立刻跑一次」的例外。
      dueAt: nextOccurrence(rule, { from: now, after: now }),
      recurrence: rule,
      payload,
    });
  },

  list: async () => await store.listTimers(sessionId),

  cancel: async (id) => await store.cancelTimer(sessionId, id),
});
