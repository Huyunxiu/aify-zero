import type {
  CompactionPolicyOverrides,
  ResolvedCompactionPolicy,
} from "./types";

const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_MAX_SUMMARY_TOKENS = 8192;
const DEFAULT_MIN_SUMMARIZE_TOKENS = 2000;

const DEFAULT_PRUNE_THRESHOLD_CHARS = 8192;
const DEFAULT_PRUNE_HEAD_CHARS = 4096;
const DEFAULT_PRUNE_TAIL_CHARS = 1024;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, Math.floor(finiteNumber(value, fallback)));
}

function positive(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(finiteNumber(value, fallback)));
}

/**
 * 解析某个模型对应的压缩策略。
 *
 * 窗口来自模型配置（`limit.context`）。没有窗口就没有可比较的压力阈值，
 * 因此显式关闭自动压缩，而不是猜一个值；手工压缩仍可基于保留预算工作。
 */
export function resolvePolicy(input?: {
  contextWindow?: number;
  overrides?: CompactionPolicyOverrides;
}): ResolvedCompactionPolicy {
  const overrides = input?.overrides ?? {};
  const auto = overrides.auto ?? true;
  const thresholdRatio = Math.min(
    0.95,
    Math.max(
      0.5,
      finiteNumber(overrides.thresholdRatio, DEFAULT_THRESHOLD_RATIO)
    )
  );
  const reserveTokens = nonNegative(
    overrides.reserveTokens,
    DEFAULT_RESERVE_TOKENS
  );
  const maxSummaryTokens = positive(
    overrides.maxSummaryTokens,
    DEFAULT_MAX_SUMMARY_TOKENS
  );
  const configuredKeepRecent = nonNegative(
    overrides.keepRecentTokens,
    DEFAULT_KEEP_RECENT_TOKENS
  );

  const rawWindow = input?.contextWindow;
  const contextWindow =
    typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.floor(rawWindow)
      : undefined;

  let disabledReason: string | undefined;
  let thresholdTokens: number | undefined;
  if (!auto) {
    disabledReason = "automatic compaction is disabled by configuration";
  } else if (contextWindow === undefined) {
    disabledReason = "the model has no configured context window";
  } else {
    const messageBudget = contextWindow - reserveTokens;
    const pressureBudget = messageBudget;
    if (pressureBudget <= 0) {
      disabledReason = `reserveTokens (${reserveTokens}) leaves no room in a ${contextWindow}-token window`;
    } else {
      thresholdTokens = Math.floor(
        Math.min(contextWindow * thresholdRatio, pressureBudget)
      );
      if (thresholdTokens <= 0) {
        disabledReason = "the resolved compaction threshold is not positive";
        thresholdTokens = undefined;
      }
    }
  }

  // 保留半个窗口以上会让压缩失去意义，而且保留段本身就可能超过阈值；
  // 因此向更小的方向夹取。
  const keepRecentTokens =
    thresholdTokens === undefined
      ? configuredKeepRecent
      : Math.min(configuredKeepRecent, Math.floor(thresholdTokens * 0.5));

  // 剪枝预算暂时固定：这是策略细节，不应该要求宿主先调好参数才能用上这个功能。
  const pruneThresholdChars = DEFAULT_PRUNE_THRESHOLD_CHARS;
  const pruneHeadChars = DEFAULT_PRUNE_HEAD_CHARS;
  const pruneTailChars = DEFAULT_PRUNE_TAIL_CHARS;

  return {
    auto,
    contextWindow,
    thresholdTokens,
    thresholdRatio,
    reserveTokens,
    keepRecentTokens,
    pruneToolResults: overrides.pruneToolResults ?? true,
    pruneThresholdChars,
    pruneHeadChars,
    pruneTailChars,
    maxSummaryTokens,
    minSummarizeTokens: DEFAULT_MIN_SUMMARIZE_TOKENS,
    disabledReason,
  };
}

export function shouldCompact(
  tokens: number,
  policy: ResolvedCompactionPolicy
): boolean {
  return (
    policy.thresholdTokens !== undefined && tokens >= policy.thresholdTokens
  );
}
