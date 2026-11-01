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
 * Reads the turn a session is running.
 *
 * Located by session rather than by stream id: the id a client holds is the
 * session's, and the stream id names one particular turn.
 *
 * A reader that attaches part-way through gets the turn from its start — the
 * entry replays what it has buffered — so a page that reloaded can pick the
 * turn up rather than join it mid-sentence. Several readers may do this at
 * once; each gets its own stream.
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
 * Stops the turn a session is running.
 *
 * Nothing else can, now that a turn outlives its request: closing the window
 * that asked for it leaves it running on purpose. Absent a running turn this is
 * a no-op rather than an error — the caller asked for the turn to not be
 * running, and it is not.
 *
 * Answers only once the turn has ended, so a caller that stops and then reads
 * the session finds the aborted turn rather than racing its write.
 *
 * A session left marked as running with no turn behind it — one that ended with
 * the process, or that finished just before the lookup — has that marker
 * cleared, so a reloaded client is not left trying to resume a turn that is
 * gone. That is also why the marker is cleared here rather than left to the
 * turn's own finish: this one runs behind a hook and a store write, and the
 * stop should answer with the session already settled.
 *
 * Both paths settle the session to `canceled`: the turn the caller asked to
 * stop is one that did not run to completion, whether this call ended it or
 * found it already gone.
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
