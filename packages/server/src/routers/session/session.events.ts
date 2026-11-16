import { streamToEventIterator } from "@orpc/server";
import { parseSessionCursor } from "@workspace/agent-client";
import z from "zod";

import { publicProcedure } from "../../index";
import { agentRunner } from "../../runtime";

/**
 * 读一个会话接下来发生的事。
 *
 * 按会话定位，不按运行：一个会话会接连跑很多次运行，页面只需要一条连接。
 * 运行结束不关闭连接——下一次运行的 `run.start` 会接着送到这里，这正是排队
 * 的消息能被看见的原因。
 *
 * 没有运行的会话不算错误：连接先建立，等它的第一次运行。`since` 是断线重连
 * 的游标，认不出来就当作没有，重连的人多读一遍比少读一段好。
 */
export const streamSessionEvents = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/events" })
  .input(
    z.object({
      sessionId: z.string(),
      since: z.string().optional(),
    })
  )
  .handler(({ input }) => {
    const since = input.since ? parseSessionCursor(input.since) : undefined;

    return streamToEventIterator(agentRunner.subscribe(input.sessionId, since));
  });
