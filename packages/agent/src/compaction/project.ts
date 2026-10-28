import type { AgentTurn, CompactionRecord } from "@workspace/agent-client";
import type { ModelMessage, ToolSet } from "ai";

import {
  convertStepToModelMessages,
  convertToModelMessages,
} from "../utils/convert-to-model-message";
import { compactionRecordOf } from "./marker";
import { frameCheckpoint } from "./prompt";
import type {
  ProjectedHistory,
  StepAnchor,
  TurnAnchor,
  UsageAnchor,
} from "./types";

/**
 * 把持久化的 turns 投影成模型请求要用的消息历史，并同时记录消息位置锚点。
 *
 * turns 按存储顺序扫描；普通 user turn 转换为 user 消息，assistant turn 则逐个
 * 转换其中可供模型使用的 assistant step。转换结果为空的 turn/step 不会生成消息，
 * 也不会产生对应锚点，因此返回的所有 `messageIndex` 都指向最终的 `messages`。
 *
 * 压缩记录是历史重建的分界点。每遇到有效的压缩记录，就丢弃当前累计的消息、
 * 锚点、最近 user/assistant turn 和 usage 信息，再以该记录的 summary 作为新的
 * checkpoint 消息开始累计。压缩记录既可能单独存于 compaction turn，也可能出现在
 * assistant turn 的 step 中；从左到右扫描意味着最新的有效记录会覆盖较早的记录，
 * 且同一 assistant turn 中分界点之后的 step 仍会被保留。
 *
 * 返回的锚点只描述最后一个 checkpoint 之后、模型实际会收到的内容：
 * - `turnAnchors` 标记每个有可见消息的 turn 在消息数组中的起点。
 * - `stepAnchors` 标记每个有可见消息的 assistant step 起点及其原始 step 索引。
 * - `lastUserTurn` 和 `lastAssistantTurnId` 记录保留历史中的最近 user/assistant turn。
 * - `usageAnchor` 记录最后一个 checkpoint 之后，具有正数 input token 用量的最新
 *   assistant step 的消息起点，用于后续上下文 token 测量。
 *
 * @param turns 按时间/存储顺序排列的一条 branch 的 turns。
 * @returns 模型消息、压缩 checkpoint，以及定位这些消息所需的 turn、step 和 usage 锚点。
 */
export async function projectHistory<TOOLS extends ToolSet>(
  turns: readonly AgentTurn<TOOLS>[]
): Promise<ProjectedHistory> {
  let messages: ModelMessage[] = [];
  let turnAnchors: TurnAnchor[] = [];
  let stepAnchors: StepAnchor[] = [];
  let lastUserTurn: TurnAnchor | undefined;
  let lastAssistantTurnId: string | undefined;
  let checkpoint: CompactionRecord | undefined;
  let usageAnchor: UsageAnchor | undefined;
  let lastMarkerAt = Number.NEGATIVE_INFINITY;

  // 手工压缩的 turn 线性追加在 branch 末尾，切点由记录里的
  // `retainedFromTurnId` 给出，而不是由 marker 在 branch 中的位置给出。
  // 找到最后一个这样的标记，从它的保留段起点开始读取：checkpoint 先就位，
  // 保留段原样接在后面，标记本身则跳过（它的效果已经体现为起始 checkpoint）。
  let linearCut:
    | {
        startIndex: number;
        markerIndex: number;
        record: CompactionRecord;
      }
    | undefined;
  for (const [markerIndex, turn] of turns.entries()) {
    if (turn.type !== "compaction") {
      continue;
    }
    for (const step of turn.content) {
      if (step.type !== "compaction") {
        continue;
      }
      const record = compactionRecordOf(step);
      const retainedFromTurnId = record?.retainedFromTurnId;
      if (!record || !retainedFromTurnId) {
        continue;
      }
      const startIndex = turns.findIndex(
        (candidate) => candidate.id === retainedFromTurnId
      );
      if (startIndex === -1) {
        continue;
      }
      linearCut = { startIndex, markerIndex, record };
    }
  }

  if (linearCut) {
    messages = [
      { role: "user", content: frameCheckpoint(linearCut.record.summary) },
    ];
    checkpoint = linearCut.record;
    // 保留段里的 step 逻辑上位于 checkpoint 之后，即使它们的时间戳更早：
    // usage 锚点因此要接受它们，而不是被 marker 的 createdAt 挡掉。
    lastMarkerAt = Number.NEGATIVE_INFINITY;
  }

  // checkpoint 会替代此前的历史；与被替代的消息相关联的锚点和 usage 也必须一并清空。
  const reset = (record: CompactionRecord): void => {
    messages = [{ role: "user", content: frameCheckpoint(record.summary) }];
    turnAnchors = [];
    stepAnchors = [];
    lastUserTurn = undefined;
    lastAssistantTurnId = undefined;
    checkpoint = record;
    lastMarkerAt = record.createdAt;
    usageAnchor = undefined;
  };

  const startIndex = linearCut?.startIndex ?? 0;
  for (let turnIndex = startIndex; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]!;
    if (
      linearCut &&
      turn.type === "compaction" &&
      turnIndex <= linearCut.markerIndex
    ) {
      // 最新切点之前的手工标记都已经被它的摘要覆盖；保留段里可能还压着更早
      // 的 marker，重放它们会把最新的保留段又清掉。
      continue;
    }

    if (turn.type === "compaction") {
      // 单独的 compaction turn 只承载标记，不直接成为模型对话消息。
      for (const step of turn.content) {
        if (step.type !== "compaction") {
          continue;
        }
        const record = compactionRecordOf(step);
        if (record) {
          reset(record);
        }
      }
      continue;
    }

    if (turn.type === "user") {
      // 锚点指向转换后第一条消息；无可投影消息的 user turn 不参与历史定位。
      const turnMessages = await convertToModelMessages<TOOLS>([turn]);
      if (turnMessages.length > 0) {
        const anchor: TurnAnchor = {
          turnId: turn.id,
          messageIndex: messages.length,
        };
        turnAnchors.push(anchor);
        lastUserTurn = anchor;
        messages.push(...turnMessages);
      }
      continue;
    }

    let turnAnchorIndex: number | undefined;
    for (const [stepIndex, step] of turn.content.entries()) {
      if (step.type === "compaction") {
        const record = compactionRecordOf(step);
        if (record) {
          reset(record);
          turnAnchorIndex = undefined;
        }
        continue;
      }
      // steering step 在模型侧是一条 user 消息，位置就是它在 turn 里的位置。
      // 它不是新的 turn 边界，所以不更新 lastUserTurn / stepAnchors。
      if (step.type === "steering") {
        const stepMessages = await convertStepToModelMessages<TOOLS>(step);
        if (stepMessages.length > 0) {
          if (turnAnchorIndex === undefined) {
            turnAnchorIndex = messages.length;
          }
          messages.push(...stepMessages);
        }
        continue;
      }
      if (step.type !== "assistant") {
        continue;
      }

      const stepMessages = await convertStepToModelMessages<TOOLS>(step);
      if (stepMessages.length === 0) {
        continue;
      }

      // 一个 assistant turn 可能产生多条模型消息；step 锚点指向该 step 的首条消息。
      if (turnAnchorIndex === undefined) {
        turnAnchorIndex = messages.length;
      }
      stepAnchors.push({
        turnId: turn.id,
        stepId: step.id,
        stepIndex,
        messageIndex: messages.length,
      });
      messages.push(...stepMessages);
      lastAssistantTurnId = turn.id;

      const inputTokens = step.usage?.inputTokens;
      if (
        typeof inputTokens === "number" &&
        inputTokens > 0 &&
        step.createdAt > lastMarkerAt
      ) {
        // 后续符合条件的 step 会覆盖此锚点，因此最终保留最近一次可用的 usage。
        usageAnchor = {
          messageIndex: messages.length - stepMessages.length,
          inputTokens,
        };
      }
    }

    if (turnAnchorIndex !== undefined) {
      turnAnchors.push({ turnId: turn.id, messageIndex: turnAnchorIndex });
    }
  }

  return {
    messages,
    turnAnchors,
    stepAnchors,
    lastUserTurn,
    lastAssistantTurnId,
    checkpoint,
    usageAnchor,
  };
}
