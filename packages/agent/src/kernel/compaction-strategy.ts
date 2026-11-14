import type { ModelRef } from "@workspace/shared/model";

import type {
  CompactionPolicyOverrides,
  ResolvedCompactionPolicy,
  SummarizeFn,
} from "../compaction/types";

/**
 * 上下文压缩的策略。
 *
 * 内核知道*何时*检查、*如何*把结果写回会话；阈值、保留预算和摘要提示由
 * 策略决定。默认实现由 `CompactionExtension` 提供，宿主可以注册自己的扩展
 * 换掉它。
 */
export interface CompactionStrategy {
  /**
   * 为一个会话解析策略；自动压缩关闭时 `thresholdTokens` 缺省。
   *
   * 窗口来自宿主配置的模型表，覆盖项来自用户设置；两者都由内核从上下文
   * 里取，策略只负责算。
   */
  policy(input?: {
    contextWindow?: number;
    overrides?: CompactionPolicyOverrides;
  }): ResolvedCompactionPolicy;
  /** 摘要器；按模型解析，因为一个 turn 中途可能换模型。 */
  summarize(model: ModelRef): SummarizeFn;
}
