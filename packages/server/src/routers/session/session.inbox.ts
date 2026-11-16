import { type } from "@orpc/server";
import { AgentInbox, STREAM_REGISTRY } from "@workspace/agent";
import type { AgentUserTurn } from "@workspace/agent-client";
import type { ModelRef } from "@workspace/shared/model";
import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { sessionRunner } from "../../session/runner";
import { SQLiteStore } from "../../storage/sqlite-store";
import { inboxItemIdSchema, resolveDeliverAt } from "./session.schema";
import type { InboxMode } from "./session.schema";

/**
 * 列出会话的待办项。
 *
 * 已领取的行会被删除，所以这里只返回仍然排队的项；客户端刷新后据此恢复队列条。
 */
export const listInboxItems = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/inbox" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { messages: await inbox.list(input.sessionId) };
  });

/**
 * 入队一条待办项。
 *
 * 交付边界由当前流决定：运行中的普通回合 + steering 才能插进下一个步边界；
 * 空闲、等待审批、手工压缩都排到下一次运行。同 (sessionId, dedupeKey) 的重试
 * 返回已有行，不会重复入队。
 */
export const enqueueInboxItem = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/inbox" })
  .errors({ SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND })
  .input(
    type<{
      sessionId: string;
      dedupeKey: string;
      mode: InboxMode;
      turn: AgentUserTurn;
      model: ModelRef;
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
    const deliverAt = resolveDeliverAt({
      mode: input.mode,
      running: running !== undefined && !running.isDone(),
      streamKind: running?.agent.streamKind,
    });

    const inbox = new AgentInbox(store);
    const message = await inbox.enqueue({
      sessionId: input.sessionId,
      kind: "user-message",
      dedupeKey: input.dedupeKey,
      deliverAt,
      content: input.turn,
      payload: {
        model: input.model,
        modelEffort: input.modelEffort,
        projectId: session.projectId ?? input.projectId ?? undefined,
      },
    });

    // 入队就算投递成功：唤醒运行器，让它在空闲时自己开始。页面随后关掉也不
    // 影响这一条。
    sessionRunner().wakeAfterPause(input.sessionId);

    return { message };
  });

/** 移除一条待办项。 */
export const cancelInboxItem = publicProcedure
  .route({
    method: "DELETE",
    path: "/sessions/{sessionId}/inbox/{itemId}",
  })
  .input(inboxItemIdSchema)
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { removed: await inbox.cancel(input.sessionId, input.itemId) };
  });

/** 清空会话的待办项。 */
export const clearInboxItems = publicProcedure
  .route({ method: "DELETE", path: "/sessions/{sessionId}/inbox" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { removed: await inbox.clear(input.sessionId) };
  });
