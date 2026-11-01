import { findTurnWithoutToolResult } from "@workspace/agent-client";
import { getErrorMessage } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";
import type { ModelMessage } from "ai";

import type { AgentContext } from "../agent-context";
import type { AgentSession } from "../agent-session";
import { compactHistory } from "../compaction/compact";
import { estimateMessagesTokens, estimateTokens } from "../compaction/estimate";
import { createCompactionStep } from "../compaction/marker";
import { isContextOverflowError } from "../compaction/overflow";
import { shouldCompact } from "../compaction/policy";
import { pruneOlderToolResults } from "../compaction/prune";
import {
  findEndPlacement,
  findPreTurnPlacement,
  measureContext,
} from "../compaction/select";
import type {
  ResolvedCompactionPolicy,
  SummarizeFn,
} from "../compaction/types";
import type {
  HookContext,
  HooksManager,
  StepEndEvent,
  StepStartEvent,
} from "../hooks-manager";
import { applyRuntimeSettingsPatches } from "../hooks-manager";
import type { AgentStore } from "../storage";
import { generateEventId, generateStepId } from "../utils/id-util";
import type { CompactionStrategy } from "./compaction-strategy";
import type { TranscriptJournal } from "./transcript-journal";
import { ZERO_USAGE } from "./usage";

/** 同一 turn 内最多主动压缩几次，防止压缩后仍超阈值时反复摘要。 */
const MAX_COMPACTIONS_PER_TURN = 3;

export type CompactionInput = {
  trigger: "pressure" | "overflow";
  mode: "before-turn" | "end";
  /** 当前 assistant turn；`before-turn` 不需要。 */
  turnId?: string;
};

export interface CompactionControllerDeps {
  store: AgentStore;
  session: AgentSession;
  context: AgentContext;
  hooks: HooksManager;
  extensionApi: HookContext;
  /** 当前注册的压缩策略；没有扩展提供时为 undefined。 */
  strategy(): CompactionStrategy | undefined;
  journal: TranscriptJournal;
  /** 当前 turn 拼好的系统提示，用于估算固定开销。 */
  instructions(): string;
}

/**
 * 上下文压缩的触发、选段和提交。
 *
 * 它不知道 turn 循环；调用方在 turn 边界、步边界或溢出时调用
 * {@link maybeCompact}。压缩记录仍然通过同一套协议事件写出。
 */
export class CompactionController {
  readonly #deps: CompactionControllerDeps;
  #compactionsThisTurn = 0;
  #lastCompactionGuard?: { messageCount: number; tokens: number };

  constructor(deps: CompactionControllerDeps) {
    this.#deps = deps;
  }

  /** 每个 turn 开始时清空本 turn 的压缩记账。 */
  resetTurn(): void {
    this.#compactionsThisTurn = 0;
    this.#lastCompactionGuard = undefined;
  }

  /**
   * 模型报告上下文溢出时尝试恢复。
   *
   * @returns 是否已经压缩并替换了历史。
   */
  async handleOverflow(error: unknown, turnId: string): Promise<boolean> {
    if (!isContextOverflowError(error)) {
      return false;
    }

    try {
      return await this.maybeCompact({
        trigger: "overflow",
        mode: "end",
        turnId,
      });
    } catch (compactionError) {
      logger.warn("[agent] overflow compaction failed", compactionError);
      return false;
    }
  }

  /**
   * 尝试缩短当前会话的模型历史：先按策略剪枝旧工具结果，必要时再摘要压缩历史。
   *
   * `pressure` 表示常规的上下文压力检查：仅在启用自动压缩、达到压缩阈值且本 turn
   * 未超过重试上限时继续。`overflow` 表示模型调用已遇到上下文溢出，不受自动压缩
   * 开关和每 turn 次数上限限制，但仍须通过工具调用完整性、可压缩区间等检查。
   *
   * `before-turn` 将当前历史中最近 user turn 之前的消息作为摘要候选区间，并把压缩
   * 标记放在新 turn 之前；`end` 则将当前 turn 末尾作为候选区间和标记插入位置。
   * 两种模式都会保留候选区间之后的消息，让下一次模型请求使用 checkpoint 加保留段。
   *
   * 成功时把压缩记录写回会话、替换模型侧历史，并更新本 turn 的计数和防重复压缩
   * 标记。失败或不满足条件时返回 `false`；但剪枝发生在摘要尝试之前，因此即使后续
   * 不压缩，已经剪掉工具结果的 `modelMessages` 也会保留。压力压缩是优化，不应仅因
   * 无法压缩而中断当前 turn。
   */
  async maybeCompact(input: CompactionInput): Promise<boolean> {
    const { session, context } = this.#deps;
    const policy = this.#resolvePolicy();
    // 没有策略就没有阈值：压缩整体不可用，而不是退化成某个默认值。
    if (!policy) {
      return false;
    }
    // 压力压缩可由配置关闭；溢出恢复则仍然尝试，避免失去恢复上下文的机会。
    if (input.trigger === "pressure" && !policy.auto) {
      return false;
    }
    // 同一 turn 设上限，防止压缩后仍触发压力检查时不断重复摘要。
    if (
      input.trigger === "pressure" &&
      this.#compactionsThisTurn >= MAX_COMPACTIONS_PER_TURN
    ) {
      return false;
    }

    let messages = session.modelMessages;
    if (policy.pruneToolResults) {
      // 先移除/截短较旧的工具结果；若产生新数组，立即同步模型侧会话历史。
      const pruned = pruneOlderToolResults(messages, {
        keepRecentTokens: policy.keepRecentTokens,
        thresholdChars: policy.pruneThresholdChars,
        headChars: policy.pruneHeadChars,
        tailChars: policy.pruneTailChars,
      });
      if (pruned !== messages) {
        messages = pruned;
        session.modelMessages = pruned;
      }
    }

    // 使用最新的 provider usage（若尚无则估算），并把 instructions 等固定开销计入。
    const measurement = measureContext({
      messages,
      usage: session.lastUsage,
      overheadTokens: this.#overheadTokens(),
    });
    // 常规压力触发必须达到阈值；overflow 触发即使尚未达到估算阈值也继续恢复。
    if (
      input.trigger === "pressure" &&
      !shouldCompact(measurement.tokens, policy)
    ) {
      return false;
    }
    // 如果历史长度没有增长、但压缩后仍超阈值，跳过重复的无进展压缩。
    if (
      input.trigger === "pressure" &&
      this.#lastCompactionGuard !== undefined &&
      messages.length <= this.#lastCompactionGuard.messageCount &&
      measurement.tokens >= (policy.thresholdTokens ?? Number.POSITIVE_INFINITY)
    ) {
      return false;
    }
    // 不能在工具调用尚未返回结果时改写历史，否则会留下不完整的工具交互。
    if (
      this.#hasUnresolvedToolCall(messages) ||
      findTurnWithoutToolResult(session.turns) !== null
    ) {
      return false;
    }

    let placement: { turnId: string; stepIndex: number };
    let regionEnd: number;
    if (input.mode === "before-turn") {
      // 找到下一个 turn 前可写入压缩 step 的位置；只摘要最近 user turn 之前的历史。
      const found = findPreTurnPlacement(session.turns);
      const { lastUserTurn } = session.projected;
      if (!found || !lastUserTurn) {
        return false;
      }
      placement = found;
      regionEnd = lastUserTurn.messageIndex;
    } else {
      // turn 收尾或 overflow 恢复时，将压缩标记挂到当前 assistant turn 的末尾。
      if (!input.turnId) {
        return false;
      }
      const found = findEndPlacement(session.turns, input.turnId);
      if (!found) {
        return false;
      }
      placement = found;
      regionEnd = messages.length;
    }

    // checkpoint 本身位于消息 0，不纳入新摘要；否则重复压缩可能摘要已有摘要。
    const start = session.projected.checkpoint ? 1 : 0;
    if (
      estimateMessagesTokens(messages.slice(start, regionEnd)) <
      policy.minSummarizeTokens
    ) {
      return false;
    }

    // 先开出 compaction step 与 part，再调用压缩流水线；后者拿到精确的候选区间
    // 和取消信号。part 从 start 起就以 streaming 存在，摘要失败时由
    // compaction.error 把它和这个 step 一起撤回。
    const compactionId = generateEventId();
    const stepId = generateStepId();
    const createdAt = Date.now();
    const stepEvent: StepStartEvent = {
      sessionId: context.sessionId,
      turnId: placement.turnId,
      stepId,
      stepType: "compaction",
      modelId: context.modelId,
    };
    let stepStatus: StepEndEvent["status"] = "error";
    const stepStart = await this.#deps.hooks.emitAsyncHooks(
      "step_start",
      stepEvent,
      this.#deps.extensionApi
    );
    const { modelId: stepModelId } = applyRuntimeSettingsPatches(
      { modelId: context.modelId, instructions: "" },
      stepStart
    );
    stepEvent.modelId = stepModelId;
    await context.controller?.write({
      type: "step.start",
      stepType: "compaction",
      model: stepModelId,
      turnId: placement.turnId,
      stepId,
      createdAt,
    });
    await context.controller?.write({
      type: "compaction.start",
      id: compactionId,
      trigger: input.trigger,
      turnId: placement.turnId,
      stepId,
      createdAt,
    });
    await this.#deps.hooks.emit(
      "pre_compact",
      { sessionId: context.sessionId, trigger: input.trigger },
      this.#deps.extensionApi
    );

    try {
      const result = await compactHistory({
        projected: {
          ...session.projected,
          messages,
          usageAnchor: session.lastUsage,
        },
        policy,
        trigger: input.trigger,
        modelId: stepModelId,
        summarize: this.summarize(stepModelId),
        region: { start, end: regionEnd },
        signal: context.abortSignal,
      });
      if (!result) {
        // 区间在进入流水线前已经校验过，理论上不会走到这里；真到了就把刚开出的
        // part 撤回，避免留下一个永远 streaming 的标记。
        await context.controller?.write({
          type: "compaction.error",
          id: compactionId,
          error: "compaction produced no record",
          createdAt: Date.now(),
        });
        stepStatus = "error";
        return false;
      }

      // 记录写到 start 时开出的 step/part 上，让存储和 turn assembler 都能重建该标记。
      // 结束时间要重新读：step.start 的 createdAt 早于摘要调用，不能拿它当耗时终点。
      const completedAt = Date.now();
      await context.controller?.write({
        type: "compaction.end",
        id: compactionId,
        turnId: placement.turnId,
        stepId,
        record: result.record,
        createdAt: completedAt,
      });
      await context.controller?.write({
        stepId,
        turnId: placement.turnId,
        type: "step.finish",
        createdAt: completedAt,
        usage: ZERO_USAGE,
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        status: "done",
      });

      // assembler 通常会因上述事件追加 step；无 controller 时也显式更新 turn，保持测试
      // 和其他轻量调用方看到的会话状态一致。
      const turn = session.turns.find(
        (candidate) => candidate.id === placement.turnId
      );
      if (
        turn?.type === "assistant" &&
        !turn.content.some((step) => step.id === stepId)
      ) {
        turn.content.push(createCompactionStep(result.record));
      }

      // checkpoint 替代被摘要区间，区间之后的消息原样保留。
      const nextMessages = [result.checkpoint, ...messages.slice(regionEnd)];
      session.applyCompaction({
        checkpoint: result.record,
        messages: nextMessages,
      });
      this.#compactionsThisTurn += 1;
      this.#lastCompactionGuard = {
        messageCount: nextMessages.length,
        tokens: result.record.tokensAfter,
      };

      // before-turn 的压缩 step 不一定属于当前正在构建的 turn，因此显式持久化更新。
      // 只写这条 step：它前面的 step 早已落库，整条 turn 重写没有必要。
      if (input.mode === "before-turn" && turn) {
        await this.#deps.journal.persistStep(turn.id, stepId);
      }

      await this.#deps.hooks.emit(
        "post_compact",
        { sessionId: context.sessionId, record: result.record },
        this.#deps.extensionApi
      );
      stepStatus = "done";
      return true;
    } catch (error) {
      if (context.abortSignal?.aborted) {
        stepStatus = "aborted";
        return false;
      }
      // 摘要/持久化异常作为可恢复的压缩失败记录；不把压力压缩失败升级为 turn 失败。
      logger.warn("[agent] compaction failed", error);
      await context.controller?.write({
        type: "compaction.error",
        id: compactionId,
        error: getErrorMessage(error),
        createdAt: Date.now(),
      });
      stepStatus = "error";
      return false;
    } finally {
      await this.#deps.hooks.emit(
        "step_end",
        {
          ...stepEvent,
          status: stepStatus,
          ...(stepStatus === "done"
            ? { usage: ZERO_USAGE, finishReason: "stop" }
            : {}),
        },
        this.#deps.extensionApi
      );
    }
  }

  /**
   * 当前会话的压缩策略。
   *
   * 宿主为单个会话解析好的策略优先；否则用注册的扩展。两者都没有时压缩
   * 不可用，调用方应当先看 {@link available}。
   */
  policy(): ResolvedCompactionPolicy {
    const policy = this.#resolvePolicy();
    if (!policy) {
      throw new Error("no compaction strategy is registered");
    }
    return policy;
  }

  summarize(modelId = this.#deps.context.modelId): SummarizeFn {
    const summarize =
      this.#deps.context.summarize ?? this.#deps.strategy()?.summarize(modelId);
    if (!summarize) {
      throw new Error("no compaction strategy is registered");
    }
    return summarize;
  }

  #resolvePolicy(): ResolvedCompactionPolicy | undefined {
    const { context } = this.#deps;
    const strategy = this.#deps.strategy();
    return (
      context.compaction ??
      strategy?.policy({
        contextWindow: context.modelContextWindows?.[context.modelId],
        overrides: context.compactionOverrides,
      })
    );
  }

  #overheadTokens(): number {
    // usage 锚点已经覆盖 instructions 和工具 schema；这个估算只在第一步回报
    // 真实数量之前有意义。
    return estimateTokens(this.#deps.instructions()) + 2000;
  }

  /** 历史中是否存在尚未返回结果的工具调用。 */
  #hasUnresolvedToolCall(messages: readonly ModelMessage[]): boolean {
    const calls = new Set<string>();
    const results = new Set<string>();

    for (const message of messages) {
      if (typeof message.content === "string") {
        continue;
      }
      for (const part of message.content) {
        if (part.type === "tool-call") {
          calls.add(part.toolCallId);
        } else if (part.type === "tool-result") {
          results.add(part.toolCallId);
        }
      }
    }

    for (const id of calls) {
      if (!results.has(id)) {
        return true;
      }
    }
    return false;
  }
}
