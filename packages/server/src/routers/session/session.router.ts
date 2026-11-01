import { streamToEventIterator, type } from "@orpc/server";
import {
  InboxMessageNotFoundError,
  NothingToCompactError,
  STREAM_REGISTRY,
} from "@workspace/agent";
import type { AgentToolSet } from "@workspace/agent";
import type {
  AgentTurn,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import { ModelEffort } from "@workspace/shared/constants";
import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import {
  createSessionLifecycle,
  SessionLifecycleError,
} from "../../session/lifecycle";
import { findAiModelById } from "../settings/settings.service";
import {
  cancelInboxMessage,
  clearInboxMessages,
  enqueueInboxMessage,
  listInboxMessages,
} from "./session.inbox";
import {
  getSession,
  listSessionResources,
  listSessions,
  listSessionTurns,
  markSessionRead,
  updateSession,
} from "./session.queries";
import { forkSessionSchema } from "./session.schema";

/** 把生命周期错误翻译成传输层错误；其他错误原样抛出。 */
function toApiError(error: unknown): never {
  if (error instanceof SessionLifecycleError) {
    switch (error.code) {
      case "SESSION_NOT_FOUND": {
        throw new ApiError("SESSION_NOT_FOUND", {
          data: { sessionId: error.data?.sessionId ?? "" },
        });
      }
      case "SESSION_BUSY": {
        throw new ApiError("SESSION_BUSY", {
          data: {
            sessionId: error.data?.sessionId ?? "",
            reason: error.data?.reason as
              | "running"
              | "wait_review"
              | "compacting"
              | undefined,
          },
        });
      }
      case "MESSAGE_NOT_FOUND": {
        throw new ApiError("MESSAGE_NOT_FOUND", {
          data: {
            sessionId: error.data?.sessionId ?? "",
            ...(error.data?.messageId
              ? { messageId: error.data.messageId }
              : {}),
          },
        });
      }
      case "NOTHING_TO_FORK": {
        throw new ApiError("NOTHING_TO_FORK");
      }
      default: {
        throw error;
      }
    }
  }

  if (error instanceof NothingToCompactError) {
    throw new ApiError("NOTHING_TO_COMPACT");
  }

  throw error;
}

const createSession = publicProcedure
  .route({ method: "POST", path: "/sessions" })
  .errors({
    MODEL_NOT_FOUND: ErrorMap.MODEL_NOT_FOUND,
    PROJECT_NOT_FOUND: ErrorMap.PROJECT_NOT_FOUND,
    SESSION_BUSY: ErrorMap.SESSION_BUSY,
    INBOX_MESSAGE_NOT_FOUND: ErrorMap.INBOX_MESSAGE_NOT_FOUND,
  })
  .input(
    type<{
      sessionId: string;
      turns: AgentTurn<AgentToolSet>[];
      approvals?: TextStreamToolApprovalResponseEvent[];
      model: string;
      modelEffort?: string;
      projectId?: string;
      inboxId?: string;
    }>()
  )
  .handler(async ({ input }) => {
    const {
      sessionId,
      turns,
      approvals,
      model,
      modelEffort,
      projectId,
      inboxId,
    } = input;

    const aiModel = await findAiModelById(model);
    if (!aiModel) {
      throw new ApiError("MODEL_NOT_FOUND", { data: { model } });
    }

    const effort = Object.values(ModelEffort).includes(
      modelEffort as ModelEffort
    )
      ? (modelEffort as ModelEffort)
      : undefined;

    try {
      return await createSessionLifecycle().create({
        sessionId,
        turns,
        approvals,
        aiModel,
        effort,
        projectId,
        inboxId,
      });
    } catch (error) {
      if (error instanceof InboxMessageNotFoundError) {
        throw new ApiError("INBOX_MESSAGE_NOT_FOUND", {
          data: { sessionId, messageId: error.id },
        });
      }
      toApiError(error);
    }
  });

/**
 * 读取会话正在运行的回合。
 *
 * 按会话定位，而不是按 stream id 定位：客户端持有的是会话 id，而 stream id 只
 * 命名某一个回合。
 *
 * 中途接入的读取方会从回合开头读起——入口会重放已缓冲的内容——所以刷新过的
 * 页面能重新接上这个回合，而不是从句中接入。多个读取方可以同时这样做，每个
 * 读取方拿到自己的流。
 */
export const streamSession = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/stream" })
  .errors({ STREAM_NOT_FOUND: ErrorMap.STREAM_NOT_FOUND })
  .input(z.object({ sessionId: z.string() }))
  .handler(({ input }) => {
    const streamEntry = STREAM_REGISTRY.getStreamEntryBySession(
      input.sessionId
    );
    if (!streamEntry) {
      throw new ApiError("STREAM_NOT_FOUND", {
        data: { sessionId: input.sessionId },
      });
    }

    return streamToEventIterator(streamEntry.readable());
  });

/**
 * 停止会话正在运行的回合。
 *
 * 现在只有这个入口能停：回合的生命周期长于它的请求，关闭发起请求的窗口后，
 * 回合会按设计继续运行。没有正在运行的回合时，这里不做任何事，也不报错——
 * 调用方要求的就是「没有回合在跑」，而事实就是这样。
 *
 * 回合结束后才返回，所以先停止、再读会话的调用方能读到已中止的回合，而不会
 * 和它的写入抢先后。
 *
 * 会话被标记为运行中、背后却没有回合时——回合随进程一起结束，或在查找前一刻
 * 刚好结束——这里会清掉该标记，免得刷新后的客户端去恢复一个已经不存在的回合。
 * 标记在这里清、而不是留给回合自己结束时清，也是这个原因：这条路径跑在 hook
 * 和一次存储写入之后，停止应当在会话已经落定后才作答。
 *
 * 两条路径都把会话落定为 `canceled`：调用方要求停止的回合没有跑完，无论这次
 * 调用是结束了它，还是发现它早已结束。
 *
 * 子会话的行也在这里收尾。父一停，子 agent 的 signal 跟着停（见
 * `createSubagent`），它自己会把行清掉——但那要等它跑完，而进程被杀时根本不会
 * 发生。所以停完再按库扫一遍父派生出的会话，把还挂着 `activeStreamId` 的行清掉，
 * 免得刷新后有一个永远"运行中"的子会话。
 */
export const stopSession = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/stop" })
  .input(z.object({ sessionId: z.string() }))
  .handler(({ input }) => createSessionLifecycle().stop(input.sessionId));

export const forkSession = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/fork" })
  .errors({
    SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND,
    MESSAGE_NOT_FOUND: ErrorMap.MESSAGE_NOT_FOUND,
    NOTHING_TO_FORK: ErrorMap.NOTHING_TO_FORK,
  })
  .input(forkSessionSchema)
  .handler(async ({ input }) => {
    try {
      return await createSessionLifecycle().fork(input);
    } catch (error) {
      toApiError(error);
    }
  });

/**
 * 按需压缩一个空闲会话。
 *
 * 和普通回合一样，这里只负责准备工作并把压缩交给 stream：会话检查、agent
 * 装配、流注册，然后返回 streamId；摘要本身在后台跑。客户端从
 * `/sessions/{id}/stream` 读事件，压缩 turn 落库先于流关闭，所以读完再取
 * branch 一定能看到新标记。
 *
 * 选段仍然在流创建之前完成，`NOTHING_TO_COMPACT` 因此还是同步错误——调用方
 * 不需要先拿 streamId 再等一条失败事件才知道没有可压缩的内容。
 */
export const compactSession = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/compact" })
  .errors({
    MODEL_NOT_FOUND: ErrorMap.MODEL_NOT_FOUND,
    SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND,
    SESSION_BUSY: ErrorMap.SESSION_BUSY,
    NOTHING_TO_COMPACT: ErrorMap.NOTHING_TO_COMPACT,
  })
  .input(z.object({ sessionId: z.string(), model: z.string() }))
  .handler(async ({ input }) => {
    const { sessionId, model } = input;
    const aiModel = await findAiModelById(model);
    if (!aiModel) {
      throw new ApiError("MODEL_NOT_FOUND", { data: { model } });
    }

    try {
      return await createSessionLifecycle().compact({ sessionId, aiModel });
    } catch (error) {
      toApiError(error);
    }
  });

export const session = {
  createSession,
  listSessions,
  getSession,
  updateSession,
  markSessionRead,
  listSessionTurns,
  listSessionResources,
  compactSession,
  forkSession,
  streamSession,
  stopSession,
  listInboxMessages,
  enqueueInboxMessage,
  cancelInboxMessage,
  clearInboxMessages,
};
