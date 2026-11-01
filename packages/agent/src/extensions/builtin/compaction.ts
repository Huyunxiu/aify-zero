import { resolvePolicy } from "../../compaction/policy";
import { createSummarizer } from "../../compaction/summarizer";
import type { CompactionStrategy } from "../../kernel/compaction-strategy";
import { Capabilities } from "../capabilities";
import type { ExtensionAPI } from "../types";
import { Extension } from "../types";

/**
 * 默认的上下文压缩策略。
 *
 * 阈值、保留预算和摘要提示都留在这里；内核只调用 `policy()` 和
 * `summarize()`。宿主要换策略（例如关掉自动压缩、换摘要提示）时注册一个
 * 提供 `Capabilities.compaction` 的扩展即可。
 */
export class CompactionExtension extends Extension {
  init(api: ExtensionAPI): void {
    const model = api.use(Capabilities.model);
    const strategy: CompactionStrategy = {
      policy: (input) => resolvePolicy(input),
      summarize: (modelId) => createSummarizer(model.languageModel(modelId)),
    };

    api.provide(Capabilities.compaction, strategy);
  }
}
