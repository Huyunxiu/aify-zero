import type { CompactionRecord } from "@workspace/agent-client";
import type { ModelMessage } from "ai";

import { generateEventId } from "../utils/id-util";
import { estimateMessagesTokens, estimateTokens } from "./estimate";
import { createSummarizationPrompt, frameCheckpoint } from "./prompt";
import { measureContext } from "./select";
import type { CompactRequest, CompactResult } from "./types";

/** 摘要至少要比被替换的内容小这个比例。 */
const MIN_SHRINK_RATIO = 0.9;

/** 压缩尝试没有产出可用摘要。 */
export class CompactionError extends Error {
  override readonly name = "CompactionError";
}

function countShadowed(
  request: CompactRequest,
  start: number,
  end: number
): { steps: number; turns: number } {
  const inRegion = (messageIndex: number): boolean =>
    messageIndex >= start && messageIndex < end;

  return {
    turns: request.projected.turnAnchors.filter((anchor) =>
      inRegion(anchor.messageIndex)
    ).length,
    steps: request.projected.stepAnchors.filter((anchor) =>
      inRegion(anchor.messageIndex)
    ).length,
  };
}

/**
 * 把某一段历史消息压缩成一个更紧凑的 checkpoint。
 *
 * 这个函数的职责很清晰：
 * 1. 先校验要压缩的区间是否合法；
 * 2. 把这段消息和已有 summary 组装成总结 prompt；
 * 3. 调用外部 summarize 模型生成压缩后的摘要；
 * 4. 检查返回结果是否有效、是否足够短；
 * 5. 生成一条 CompactionRecord 和对应的 checkpoint 消息，供调用方持久化。
 *
 * 设计上它是“纯粹的压缩决策过程”：
 * - 不直接更新 store；
 * - 不发事件；
 * - 不修改 session；
 * 这些都交给调用方。这样它更容易测试，也更容易在不同代价策略下复用。
 *
 * 如果区间为空或非法，就返回 null；
 * 如果模型返回空内容、截断、过滤或没有明显压缩效果，就抛出 CompactionError。
 */
export async function compactHistory(
  request: CompactRequest
): Promise<CompactResult | null> {
  const { projected, policy, region, trigger, modelId, summarize, signal } =
    request;
  const { start, end } = region;

  // 1) 先做边界校验：只有合法区间才能压缩。
  // start/end 既是消息索引的范围，也决定了“被替换”的历史长度。
  if (
    start < 0 ||
    end > projected.messages.length ||
    end - start < 1 ||
    start >= end
  ) {
    return null;
  }
  signal?.throwIfAborted();

  // 2) 取出需要压缩的“阴影区间”内容，并保留前一个 checkpoint summary 作为上下文。
  // 这里的 shadowed 是最终被 summary 替代的那段内容。
  const shadowed = projected.messages.slice(start, end);
  const previousSummary = projected.checkpoint?.summary;

  // 3) 计算本次摘要时的 prompt token 上限，避免输入过大导致模型无法正常生成。
  // 如果 contextWindow 未定义，就不强制限制 prompt，否则给出一个安全上限。
  const maxPromptTokens =
    policy.contextWindow === undefined
      ? undefined
      : Math.max(512, policy.contextWindow - policy.maxSummaryTokens - 2000);

  // 4) 组装摘要指令：包含要压缩的消息、历史 summary 和 token 上限。
  const prompt = createSummarizationPrompt({
    messages: shadowed,
    previousSummary,
    maxPromptTokens,
  });

  // 5) 设定模型输出 token 上限。
  // 一般要比 maxSummaryTokens 小，避免生成过长的 checkpoint。
  const maxOutputTokens =
    policy.contextWindow === undefined
      ? policy.maxSummaryTokens
      : Math.min(
          policy.maxSummaryTokens,
          Math.max(512, Math.floor(policy.contextWindow / 8))
        );

  // 6) 调用外部摘要函数生成 checkpoint 文本。
  // 这里 summarize 是注入依赖，允许在不同环境下使用不同模型或实现。
  const output = await summarize({
    ...prompt,
    maxOutputTokens,
    signal,
  });
  signal?.throwIfAborted();

  // 7) 检查生成结果是否有效：不能为空、不能因为长度截断、中止或内容过滤而失败。
  const summary = output.text.trim();
  if (summary.length === 0) {
    throw new CompactionError("summarization produced no text");
  }
  if (output.finishReason === "length") {
    throw new CompactionError(
      "summarization hit its token cap and the checkpoint is incomplete"
    );
  }
  if (
    output.finishReason === "error" ||
    output.finishReason === "content-filter"
  ) {
    throw new CompactionError(
      `summarization ended with finish reason "${output.finishReason}"`
    );
  }

  // 8) 把摘要包装成 checkpoint 格式，再评估它是否真的比原消息更小。
  // 这一步很关键：如果总结结果没有明显缩小体积，就不值得压缩，避免“压缩后不省空间”的无效操作。
  const checkpointContent = frameCheckpoint(summary);
  const checkpointTokens = estimateTokens(checkpointContent);
  const shadowedTokens = estimateMessagesTokens(shadowed);
  if (checkpointTokens >= shadowedTokens * MIN_SHRINK_RATIO) {
    throw new CompactionError(
      `summary is not materially smaller than the content it replaces (${checkpointTokens} >= ${Math.floor(shadowedTokens * MIN_SHRINK_RATIO)})`
    );
  }

  // 9) 计算压缩前后的上下文规模，用于记录收益。
  // tokensBefore 表示压缩前的总 token 数量，tokensAfter 表示“保留尾部消息 + 新 checkpoint”后的大小。
  const tokensBefore = measureContext({
    messages: projected.messages,
    usage: projected.usageAnchor,
  }).tokens;
  const tokensAfter =
    checkpointTokens + estimateMessagesTokens(projected.messages.slice(end));
  const shadowedCounts = countShadowed(request, start, end);

  // 10) 组装压缩记录：记录摘要内容、影响的 turn/step、触发原因、模型信息和 token 使用情况。
  const record: CompactionRecord = {
    version: 1,
    id: generateEventId(),
    trigger,
    summary,
    tokensBefore,
    tokensAfter,
    shadowedTokens,
    shadowedTurns: shadowedCounts.turns,
    shadowedSteps: shadowedCounts.steps,
    model: modelId,
    usage: output.usage,
    createdAt: Date.now(),
  };

  // 11) 生成最终要写回到消息列表中的 checkpoint 对象。
  // 这里的 message 是模型消息格式，调用方可直接放回上下文中。
  const checkpoint: ModelMessage = {
    role: "user",
    content: checkpointContent,
  };

  // 12) 返回压缩记录和 checkpoint，调用方再决定是否落库、替换历史消息或更新状态。
  return { record, checkpoint };
}
