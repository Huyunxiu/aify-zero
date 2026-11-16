import { type } from "@orpc/server";
import type { InboxMode } from "@workspace/agent";
import type { AgentUserTurn } from "@workspace/agent-client";
import { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";
import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { agentRunner } from "../../runtime";
import { SQLiteStore } from "../../storage/sqlite-store";
import { inboxItemIdSchema } from "./session.schema";

/**
 * 列出会话的待办项。
 *
 * 已领取的行会被删除，所以这里只返回仍然排队的项；客户端刷新后据此恢复队列条。
 */
export const listInboxItems = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/inbox" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    return { items: await store.listInboxItems(input.sessionId) };
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

    const effort = Object.values(ModelEffort).includes(
      input.modelEffort as ModelEffort
    )
      ? (input.modelEffort as ModelEffort)
      : undefined;
    const projectId = session.projectId ?? input.projectId ?? undefined;

    // 入队就算投递成功：运行器会在空闲时自己开始。页面随后关掉也不影响这一条。
    const item = await agentRunner.enqueue({
      sessionId: input.sessionId,
      dedupeKey: input.dedupeKey,
      turn: input.turn,
      model: input.model,
      ...(effort === undefined ? {} : { effort }),
      mode: input.mode,
      ...(projectId === undefined ? {} : { projectId }),
    });

    return { item };
  });

/** 移除一条待办项。 */
export const cancelInboxItem = publicProcedure
  .route({
    method: "DELETE",
    path: "/sessions/{sessionId}/inbox/{itemId}",
  })
  .input(inboxItemIdSchema)
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    return {
      removed: await store.deleteInboxItems(input.sessionId, [input.itemId]),
    };
  });

/** 清空会话的待办项。 */
export const clearInboxItems = publicProcedure
  .route({ method: "DELETE", path: "/sessions/{sessionId}/inbox" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    return { removed: await store.deleteInboxItems(input.sessionId) };
  });
