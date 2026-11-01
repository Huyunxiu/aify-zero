import { type } from "@orpc/server";
import { AgentInbox, STREAM_REGISTRY } from "@workspace/agent";
import type { AgentUserTurn } from "@workspace/agent-client";
import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { SQLiteStore } from "../../storage/sqlite-store";
import { inboxMessageIdSchema, resolveInboxPlacement } from "./session.schema";
import type { InboxMode } from "./session.schema";

/**
 * 列出会话的待发送消息。
 *
 * 已领取的行会被删除，所以这里只返回仍然排队的消息；客户端刷新后据此恢复
 * 队列 dock。
 */
export const listInboxMessages = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/inbox" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { messages: await inbox.list(input.sessionId) };
  });

/**
 * 入队一条消息。
 *
 * placement 由当前流决定：运行中的普通回合 + steering 才是下一步；空闲、
 * 等待审批、手工压缩都排到下一回合。同 (sessionId, requestId) 的重试返回
 * 已有行，不会重复入队。
 */
export const enqueueInboxMessage = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/inbox" })
  .errors({ SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND })
  .input(
    type<{
      sessionId: string;
      requestId: string;
      mode: InboxMode;
      turn: AgentUserTurn;
      model: string;
      modelEffort?: string;
      projectId?: string;
    }>()
  )
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    const session = await store.getSessionById(input.sessionId);
    if (!session) {
      throw new ApiError("SESSION_NOT_FOUND", {
        data: { sessionId: input.sessionId },
      });
    }

    const running = STREAM_REGISTRY.getStreamEntryBySession(input.sessionId);
    const placement = resolveInboxPlacement({
      mode: input.mode,
      running: running !== undefined && !running.isDone(),
      streamKind: running?.agent.streamKind,
    });

    const inbox = new AgentInbox(store);
    const message = await inbox.enqueue({
      sessionId: input.sessionId,
      requestId: input.requestId,
      placement,
      content: input.turn,
      payload: {
        model: input.model,
        modelEffort: input.modelEffort,
        projectId: session.projectId ?? input.projectId ?? undefined,
      },
    });

    return { message };
  });

/** 移除一条待发送消息。 */
export const cancelInboxMessage = publicProcedure
  .route({
    method: "DELETE",
    path: "/sessions/{sessionId}/inbox/{messageId}",
  })
  .input(inboxMessageIdSchema)
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { removed: await inbox.cancel(input.sessionId, input.messageId) };
  });

/** 清空会话的待发送消息。 */
export const clearInboxMessages = publicProcedure
  .route({ method: "DELETE", path: "/sessions/{sessionId}/inbox" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { removed: await inbox.clear(input.sessionId) };
  });
