import { streamToEventIterator } from "@orpc/server";
import { parseSessionCursor } from "@workspace/agent-client";
import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { agentRunner } from "../../runtime";
import { SQLiteStore } from "../../storage/sqlite-store";

/**
 * 读一个会话接下来发生的事。
 *
 * 按会话定位，不按运行：一个会话会接连跑很多次运行，页面只需要一条连接。
 * 运行结束不关闭连接——下一次运行的 `run.start` 会接着送到这里，这正是排队
 * 的消息能被看见的原因。
 *
 * 没有运行的会话不算错误：连接先建立，等它的第一次运行。`since` 是断线重连
 * 的游标，认不出来就当作没有，重连的人多读一遍比少读一段好。
 *
 * 已删的会话是另一回事：它不存在，不给它开通道——否则旧标签页会挂着一条永远
 * 等不到运行的连接（ADR 0022）。注意「还没有行」不等于「已删」：新会话的页面
 * 先订阅，第一条消息到了才落行，那种订阅必须放行。
 */
export const streamSessionEvents = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/events" })
  .errors({ SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND })
  .input(
    z.object({
      sessionId: z.string(),
      since: z.string().optional(),
    })
  )
  .handler(async ({ input }) => {
    const since = input.since ? parseSessionCursor(input.since) : undefined;

    const store = new SQLiteStore();
    const row = await store.findSessionRow(input.sessionId);
    if (row !== null && row.deletedAt !== null) {
      throw new ApiError("SESSION_NOT_FOUND", {
        data: { sessionId: input.sessionId },
      });
    }

    return streamToEventIterator(agentRunner.subscribe(input.sessionId, since));
  });
