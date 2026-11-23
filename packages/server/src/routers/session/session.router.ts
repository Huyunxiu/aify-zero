import { type } from "@orpc/server";
import { AgentRunnerError, NothingToCompactError } from "@workspace/agent";
import type { AgentToolSet } from "@workspace/agent";
import { DEFAULT_BOT_ID } from "@workspace/agent-client";
import type {
  AgentTurn,
  AgentUserTurn,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";
import type { ModelRef } from "@workspace/shared/model";
import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { agentRunner } from "../../runtime";
import { releaseSessionSandbox } from "../../sandbox/registry";
import {
  acceptedEffort,
  requestedEffort,
  unsupportedInput,
} from "../../session/model-rules";
import { SQLiteStore } from "../../storage/sqlite-store";
import { resolveBotForRun } from "../bot/bot.service";
import { findProjectById } from "../project/project.repository";
import { modelRefSchema } from "../settings/settings.schema";
import { findConfiguredModel } from "../settings/settings.service";
import { streamSessionEvents } from "./session.events";
import {
  cancelInboxItem,
  clearInboxItems,
  enqueueInboxItem,
  listInboxItems,
} from "./session.inbox";
import {
  getSession,
  listSessionResources,
  listSessions,
  listSessionTurns,
  markSessionRead,
  setApprovalPolicy,
  updateSession,
} from "./session.queries";
import { approvalPolicySchema, forkSessionSchema } from "./session.schema";

/** 把生命周期错误翻译成传输层错误；其他错误原样抛出。 */
function toApiError(error: unknown): never {
  if (error instanceof AgentRunnerError) {
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
      case "SESSION_NOT_RUNNABLE": {
        throw new ApiError("SESSION_NOT_RUNNABLE", {
          data: {
            sessionId: error.data?.sessionId ?? "",
            kind: error.data?.kind === "subagent" ? "subagent" : "main",
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
    BOT_NOT_FOUND: ErrorMap.BOT_NOT_FOUND,
    MODEL_NOT_FOUND: ErrorMap.MODEL_NOT_FOUND,
    MODEL_UNSUPPORTED_INPUT: ErrorMap.MODEL_UNSUPPORTED_INPUT,
    PROJECT_NOT_FOUND: ErrorMap.PROJECT_NOT_FOUND,
    SESSION_BUSY: ErrorMap.SESSION_BUSY,
    SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND,
  })
  .input(
    type<{
      sessionId: string;
      turns: AgentTurn<AgentToolSet>[];
      approvals?: TextStreamToolApprovalResponseEvent[];
      model: ModelRef;
      modelEffort?: string;
      botId?: string;
      projectId?: string;
      inboxId?: string;
      /** The Approval Policy for the first write. The layer ignores it when the row exists; use setApprovalPolicy then. */
      approvalPolicy?: string;
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
    // The input is a type, not a schema, so check the values here, before the write.
    const approvalPolicy =
      input.approvalPolicy === undefined
        ? undefined
        : approvalPolicySchema.parse(input.approvalPolicy);

    const configured = await findConfiguredModel(model);
    if (!configured) {
      throw new ApiError("MODEL_NOT_FOUND", { data: model });
    }

    const effort = acceptedEffort(configured, requestedEffort(modelEffort));

    // 审批恢复先写回答复；它不起新的 user 回合，所以不走收件箱。
    if (approvals?.length) {
      try {
        await agentRunner.resume({
          sessionId,
          approvals,
          model,
          ...(effort === undefined ? {} : { effort }),
        });
      } catch (error) {
        toApiError(error);
      }

      return { accepted: true };
    }

    const lastTurn = turns.at(-1);
    if (!lastTurn) {
      throw new Error("no message.");
    }

    const unsupported = unsupportedInput(configured, lastTurn as AgentUserTurn);
    if (unsupported) {
      throw new ApiError("MODEL_UNSUPPORTED_INPUT", {
        data: { kind: unsupported },
      });
    }

    const store = new SQLiteStore();
    const existingRow = await store.findSessionRow(sessionId);
    const hasActiveRow = existingRow !== null && existingRow.deletedAt === null;
    const bot = await resolveBotForRun(
      hasActiveRow ? existingRow.botId : (input.botId ?? DEFAULT_BOT_ID)
    );

    const effectiveProjectId = hasActiveRow
      ? (existingRow.projectId ?? undefined)
      : (projectId ?? bot.defaultProjectId ?? undefined);
    if (!hasActiveRow && effectiveProjectId !== undefined) {
      const project = await findProjectById(effectiveProjectId);
      if (!project) {
        throw new ApiError("PROJECT_NOT_FOUND", {
          data: { projectId: effectiveProjectId },
        });
      }
    }
    const effectiveApprovalPolicy = hasActiveRow
      ? existingRow.approvalPolicy
      : (approvalPolicy ?? bot.defaultApprovalPolicy);

    // Write session row first (idempotent); deleted sessions still throw SESSION_NOT_FOUND (ADR 0022).
    try {
      await agentRunner.createSession({
        sessionId,
        botId: bot.id,
        ...(effectiveProjectId === undefined
          ? {}
          : { projectId: effectiveProjectId }),
        approvalPolicy: effectiveApprovalPolicy,
      });
    } catch (error) {
      toApiError(error);
    }

    // 已经入队的那条（客户端先入队再发）不再重复写一行。
    if (!inboxId) {
      await agentRunner.enqueue({
        sessionId,
        // 同一条消息重试时 server 认得出它：user 回合的 id 是客户端生成的。
        dedupeKey: lastTurn.id,
        turn: lastTurn as AgentUserTurn,
        model,
        ...(effort === undefined ? {} : { effort }),
        ...(effectiveProjectId === undefined
          ? {}
          : { projectId: effectiveProjectId }),
        mode: "followup",
      });
    } else {
      // 这一条已经由收件箱写入了；只需要清掉暂停、叫醒队列。
      agentRunner.wakeAfterPause(sessionId);
    }

    return { accepted: true };
  });

/**
 * 让停下来的队列继续。
 *
 * 运行失败或用户中止之后，运行器不再自动取件——它不想让一条坏消息反复触发
 * 同一个错误。暂停只存在内存里，所以「继续」也只需要在这里说一声：清掉暂停，
 * 再看一眼收件箱。
 */
export const resumeSession = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/resume" })
  .input(z.object({ sessionId: z.string() }))
  .handler(({ input }) => {
    agentRunner.wakeAfterPause(input.sessionId);

    return { accepted: true };
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
  .handler(({ input }) => agentRunner.stop(input.sessionId));

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
      return await agentRunner.fork(input.sessionId, input.messageId);
    } catch (error) {
      toApiError(error);
    }
  });

/**
 * 按需压缩一个空闲会话。
 *
 * 和普通回合一样，这里只负责准备工作并把压缩交给 stream：会话检查、agent
 * 装配、流注册，然后返回 streamId；摘要本身在后台跑。客户端的会话事件流会
 * 收到这一次运行的 `run.start` 与压缩事件，压缩 turn 落库先于流关闭，所以读完
 * 再取 branch 一定能看到新标记。
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
  .input(z.object({ sessionId: z.string(), model: modelRefSchema }))
  .handler(async ({ input }) => {
    const { sessionId, model } = input;
    const configured = await findConfiguredModel(model);
    if (!configured) {
      throw new ApiError("MODEL_NOT_FOUND", { data: model });
    }

    try {
      return await agentRunner.compact(sessionId, { model });
    } catch (error) {
      toApiError(error);
    }
  });

/**
 * 删除一个会话。
 *
 * 幂等：不存在或已经删过都返回 `removed: false`，不报未找到——调用方要的是
 * 「它不在了」，而这个事实已经成立。运行中的会话报 `SESSION_BUSY`：一次正在
 * 花钱的运行不该被一条删除请求带走（ADR 0022）。
 */
export const deleteSession = publicProcedure
  .route({ method: "DELETE", path: "/sessions/{sessionId}" })
  .errors({ SESSION_BUSY: ErrorMap.SESSION_BUSY })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    try {
      const { removed } = await agentRunner.delete(input.sessionId);
      if (removed) {
        // 沙箱句柄只有服务端认识，agent 包看不见它。释放失败只记日志：库里的事
        // 已经成立，一个缓存条目不该把删除变成失败。
        await releaseSessionSandbox(input.sessionId).catch((error: unknown) => {
          logger.warn("[session] failed to release the sandbox", error);
        });
      }
      return { sessionId: input.sessionId, removed };
    } catch (error) {
      toApiError(error);
    }
  });

export const session = {
  createSession,
  setApprovalPolicy,
  deleteSession,
  listSessions,
  getSession,
  updateSession,
  markSessionRead,
  listSessionTurns,
  listSessionResources,
  compactSession,
  forkSession,
  streamSessionEvents,
  resumeSession,
  stopSession,
  listInboxItems,
  enqueueInboxItem,
  cancelInboxItem,
  clearInboxItems,
};
