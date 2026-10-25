import type { LanguageModel } from "ai";
import { generateText } from "ai";

import type { SummarizeFn } from "./types";

/**
 * 默认摘要器：在会话模型上发起一次 `generateText` 调用。
 *
 * temperature 固定为 0，输出有上限，因为 checkpoint 应当是稳定、有界的产物；
 * 调用返回后由调用方校验空输出、截断和缩小比例。
 */
export function createSummarizer(model: LanguageModel): SummarizeFn {
  return async (input) => {
    const result = await generateText({
      model,
      system: input.system,
      prompt: input.prompt,
      temperature: 0,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.signal,
    });

    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
    };
  };
}
