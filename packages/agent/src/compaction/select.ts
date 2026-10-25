import type { AgentTurn } from "@workspace/agent-client";
import type { ModelMessage, ToolSet } from "ai";

import { estimateMessagesTokens } from "./estimate";
import type {
  ContextMeasurement,
  ManualCompactionPlan,
  ProjectedHistory,
  ResolvedCompactionPolicy,
  UsageAnchor,
} from "./types";

/** 测量下一次请求将携带的上下文。 */
export function measureContext(input: {
  messages: readonly ModelMessage[];
  usage?: UsageAnchor;
  overheadTokens?: number;
}): ContextMeasurement {
  const overhead = input.overheadTokens ?? 0;
  const { usage } = input;

  if (
    usage &&
    Number.isInteger(usage.messageIndex) &&
    usage.messageIndex >= 0 &&
    usage.messageIndex <= input.messages.length &&
    usage.inputTokens > 0
  ) {
    return {
      tokens:
        usage.inputTokens +
        estimateMessagesTokens(input.messages.slice(usage.messageIndex)),
      source: "usage",
    };
  }

  return {
    tokens: estimateMessagesTokens(input.messages) + overhead,
    source: "estimate",
  };
}

/** 自动标记落在当前 assistant turn 内的位置。 */
export interface StepPlacement {
  turnId: string;
  /** 插入到哪个 step 之前；`content.length` 表示追加到末尾。 */
  stepIndex: number;
}

/**
 * 最新 user turn 之前的那条 assistant turn。
 *
 * 回合开始前的压缩把标记放在这条 turn 末尾，让新的用户请求保持原文。若前一条
 * 不是 assistant turn（手工压缩 turn、崩溃后残留的 user turn），则跳过：
 * 把更旧的标记追加在后面会被更新的标记覆盖，或者根本没有地方可放。
 */
export function findPreTurnPlacement<TOOLS extends ToolSet>(
  turns: readonly AgentTurn<TOOLS>[]
): StepPlacement | undefined {
  if (turns.length < 2) {
    return undefined;
  }

  const previous = turns.at(-2);
  if (!previous || previous.type !== "assistant") {
    return undefined;
  }

  return { turnId: previous.id, stepIndex: previous.content.length };
}

/** 追加到当前 assistant turn 末尾的标记位置。 */
export function findEndPlacement<TOOLS extends ToolSet>(
  turns: readonly AgentTurn<TOOLS>[],
  turnId: string
): StepPlacement | undefined {
  const turn = turns.find((candidate) => candidate.id === turnId);
  if (!turn || turn.type !== "assistant") {
    return undefined;
  }

  return { turnId: turn.id, stepIndex: turn.content.length };
}

/**
 * 规划一次手工压缩。
 *
 * 保留以 turn 为粒度：手工切点不能落进一条回复内部（否则要拆 turn），所以切点
 * 会吸附到第一个保留 turn 的起点，并存进 `retainedFromTurnId`。最新的 user turn
 * 始终原文保留；如果保留段无法把上下文降到阈值以下，则退化为全量压缩（没有
 * 保留段）。压缩 turn 本身始终追加到 branch 末尾，不改变已有拓扑。
 *
 * 这里的 `region` 是模型消息数组中的半开区间 `[start, end)`，不是 branch 中
 * turn 的插入位置。摘要会覆盖这个区间；若采用 recent 模式，`retainedFromTurnId`
 * 指向区间之后第一个保留 turn，投影历史会从 checkpoint 接上该 turn 及其后续消息。
 *
 * 返回 `undefined` 表示当前历史不值得压缩：例如可压缩部分太短，且上下文还没达到
 * 压力阈值。达到阈值时，即使无法按预算保留近期历史，也会退回 full 模式来释放上下文。
 */
export function planManualCompaction<TOOLS extends ToolSet>(
  turns: readonly AgentTurn<TOOLS>[],
  projected: ProjectedHistory,
  policy: ResolvedCompactionPolicy
): ManualCompactionPlan | undefined {
  const { messages } = projected;
  // 有 checkpoint 时，messages[0] 是代表更早历史的合成摘要消息，不应再次被摘要。
  // 因此所有可压缩区间都从它之后开始；end 是半开区间的右边界。
  const start = projected.checkpoint ? 1 : 0;
  const end = messages.length;
  // 至少要有两条可压缩消息，才值得额外调用模型生成摘要。
  if (end - start < 2) {
    return undefined;
  }

  // 记录压缩前的上下文规模，用于界面展示和后续压缩记录。
  // 如果有最近一次模型 usage，就以实际输入 token 为基准，再估算其后的新增消息；
  // 否则估算整个历史，并加上固定开销，避免低估系统提示等未投影内容。
  const measurement = measureContext({
    messages,
    usage: projected.usageAnchor,
    overheadTokens: 2000,
  });
  // 手工操作本身不要求历史必须超阈值，但阈值决定后面“保留段放不下”时是否
  // 应该强制执行 full 压缩，而不是放弃本次操作。
  const overThreshold =
    policy.thresholdTokens !== undefined &&
    measurement.tokens >= policy.thresholdTokens;

  // 从最近的 turn 往前累计，找出至少覆盖 keepRecentTokens 的最早 turn。
  // chosen 初始为最旧锚点：如果全部历史加起来仍不到保留预算，就保留所有可用历史。
  // keepRecentTokens 为 0 时不选择保留段，后续会根据保留段能否放入阈值决定是否 full。
  let chosen: (typeof projected.turnAnchors)[number] | undefined =
    policy.keepRecentTokens > 0 ? projected.turnAnchors[0] : undefined;
  let accumulated = 0;
  for (
    let index = projected.turnAnchors.length - 1;
    policy.keepRecentTokens > 0 && index >= 0;
    index -= 1
  ) {
    const anchor = projected.turnAnchors[index];
    if (!anchor) {
      continue;
    }
    // 一个 anchor 覆盖从当前 turn 起点到下一 turn 起点之间的消息；
    // 最后一个 turn 则一直计算到消息数组末尾。
    const nextIndex =
      projected.turnAnchors[index + 1]?.messageIndex ?? messages.length;
    accumulated += estimateMessagesTokens(
      messages.slice(anchor.messageIndex, nextIndex)
    );
    if (accumulated >= policy.keepRecentTokens) {
      chosen = anchor;
      break;
    }
  }

  // 绝不把最新的用户请求摘要掉。若按 token 预算得出的切点落在它之后，
  // 就把切点往前挪到该 user turn，使其请求及之后的对话都原样保留。
  if (
    chosen &&
    projected.lastUserTurn &&
    chosen.messageIndex > projected.lastUserTurn.messageIndex
  ) {
    chosen = projected.lastUserTurn;
  }

  // chosen 是保留段的起点；它之前的消息将进入摘要。
  // 没有 chosen 时，regionEnd=start，后续只有 full 模式可能继续。
  const regionEnd = chosen?.messageIndex ?? start;
  // 检查保留段自身加上预计摘要的最大长度是否仍会超过上下文阈值。
  // 若会，recent 压缩不能解决压力，因此直接把可压缩区间全部交给摘要。
  const keptTokens = estimateMessagesTokens(messages.slice(regionEnd));
  const fullBecauseTailTooLarge =
    policy.thresholdTokens !== undefined &&
    keptTokens + policy.maxSummaryTokens > policy.thresholdTokens;

  // full 模式不指定 retainedFromTurnId，表示 checkpoint 替代 start 到 end 的全部
  // 可压缩消息。新压缩 turn 仍挂在 branch 当前末尾 turn 之下。
  const full = (): ManualCompactionPlan | undefined => {
    const head = turns.at(-1);
    return {
      mode: "full",
      region: { start, end },
      parentTurnId: head?.id,
      tokensBefore: measurement.tokens,
    };
  };

  if (fullBecauseTailTooLarge) {
    return full();
  }

  // 被摘要部分也必须达到最小长度，避免为很短的内容调用摘要模型、反而增加开销。
  const enoughToSummarize =
    estimateMessagesTokens(messages.slice(start, regionEnd)) >=
    policy.minSummarizeTokens;

  // 没有可用的保留 turn，或切点没有前进（没有可摘要内容）：
  // 只有已经达到压力阈值时才强制 full，否则本次手工请求不产生计划。
  if (!chosen || regionEnd <= start) {
    return overThreshold ? full() : undefined;
  }

  // 即使切点有效，如果摘要区域不足最小预算，也不做 recent 压缩；
  // 超阈值时仍可用 full 模式确保释放上下文。
  if (!enoughToSummarize) {
    return overThreshold ? full() : undefined;
  }

  // recent 计划需要一个 branch 尾部 turn 作为新压缩 turn 的 parent。
  // 正常有效历史应有 head；若没有，仅在上下文压力已超阈值时尝试 full 兜底。
  const head = turns.at(-1);
  if (!head) {
    return overThreshold ? full() : undefined;
  }

  // 切点是保留段的第一条 turn，而不是 branch 上的插入位置。
  // 摘要覆盖 start 到 regionEnd 之前的消息；投影随后从 retainedFromTurnId
  // 接回原始历史。压缩 turn 仍追加在末尾，因此不会重排已有 branch。
  return {
    mode: "recent",
    region: { start, end: regionEnd },
    retainedFromTurnId: chosen.turnId,
    parentTurnId: head.id,
    tokensBefore: measurement.tokens,
  };
}
