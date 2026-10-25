import type {
  CompactionRecord,
  CompactionTrigger,
} from "@workspace/agent-client";
import type { LanguageModelUsage, ModelMessage } from "ai";

export type { CompactionRecord, CompactionTrigger };

/** 宿主可以调整的开关；每一项都有默认值。 */
export interface CompactionPolicyOverrides {
  auto?: boolean;
  thresholdRatio?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  pruneToolResults?: boolean;
  maxSummaryTokens?: number;
}

/**
 * 压缩流水线需要的全部策略，每个 turn 解析一次。
 *
 * 模型窗口未知、或配置的 reserve 把窗口吃光时，`thresholdTokens` 缺省；这正是
 * 关闭自动压力压缩的开关。手工压缩仍可基于 `keepRecentTokens` 工作。
 */
export interface ResolvedCompactionPolicy {
  auto: boolean;
  contextWindow?: number;
  thresholdTokens?: number;
  thresholdRatio: number;
  reserveTokens: number;
  keepRecentTokens: number;
  pruneToolResults: boolean;
  pruneThresholdChars: number;
  pruneHeadChars: number;
  pruneTailChars: number;
  maxSummaryTokens: number;
  minSummarizeTokens: number;
  /** 自动压力压缩关闭的原因，供宿主记录日志。 */
  disabledReason?: string;
}

/** 一条 turn 的首条模型消息，用于把手工切点放在 turn 边界。 */
export interface TurnAnchor {
  turnId: string;
  messageIndex: number;
}

/** 一个 step 的首条模型消息，用于 usage 与位置记录。 */
export interface StepAnchor {
  turnId: string;
  stepId: string;
  stepIndex: number;
  messageIndex: number;
}

export interface UsageAnchor {
  messageIndex: number;
  inputTokens: number;
}

/**
 * 一条 branch 在模型侧的样子。
 *
 * `messages` 已经应用了所有压缩标记：每个标记都会把累计器重置成一条 checkpoint
 * 消息，因此只有最后一个标记生效。锚点描述的是最终数组中的位置，放置决策需要它。
 */
export interface ProjectedHistory {
  messages: ModelMessage[];
  turnAnchors: TurnAnchor[];
  stepAnchors: StepAnchor[];
  lastUserTurn?: TurnAnchor;
  lastAssistantTurnId?: string;
  checkpoint?: CompactionRecord;
  usageAnchor?: UsageAnchor;
}

export interface ContextMeasurement {
  tokens: number;
  source: "usage" | "estimate";
}

export interface SummarizeInput {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface SummarizeOutput {
  text: string;
  finishReason: string;
  usage?: LanguageModelUsage;
}

/**
 * 流水线唯一的模型调用。通过注入提供，测试不需要 provider，宿主以后也可以把
 * 摘要路由到更小的模型。
 */
export type SummarizeFn = (input: SummarizeInput) => Promise<SummarizeOutput>;

export interface CompactRequest {
  projected: ProjectedHistory;
  policy: ResolvedCompactionPolicy;
  trigger: CompactionTrigger;
  modelId: string;
  summarize: SummarizeFn;
  /** 要摘要的半开消息区间；必须位于 checkpoint 之后。 */
  region: { start: number; end: number };
  signal?: AbortSignal;
}

export interface CompactResult {
  record: CompactionRecord;
  /** 下一次请求开头的合成 user 消息。 */
  checkpoint: ModelMessage;
}

export interface ManualCompactionPlan {
  mode: "recent" | "full";
  region: { start: number; end: number };
  /**
   * 保留段的起点。checkpoint 替代这条 turn 之前的消息，这条 turn 及其后原样
   * 保留；缺省表示全量压缩。它同时就是记录里的切点，因此 branch 只需线性追加。
   */
  retainedFromTurnId?: string;
  /** 压缩 turn 追加到 branch 末尾，挂在这条 turn 下面。 */
  parentTurnId?: string;
  tokensBefore: number;
}
