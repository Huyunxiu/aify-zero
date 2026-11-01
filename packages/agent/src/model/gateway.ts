import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

import type { ModelGateway } from "../kernel/model-gateway";

export interface OpenAICompatibleGatewayOptions {
  apiKey: string;
  /** 兼容 OpenAI 协议的服务地址。 */
  baseURL: string;
  /** provider 名字，出现在请求头和事件里。 */
  name: string;
}

/**
 * OpenAI 兼容协议的 {@link ModelGateway} 适配器。
 *
 * 适配器只做协议转换，不缓存模型对象：同一次 turn 可能因为补丁换模型，缓存
 * 会把换模型变成隐式失败。
 */
export function createOpenAICompatibleGateway(
  options: OpenAICompatibleGatewayOptions
): ModelGateway {
  const provider = createOpenAICompatible({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    name: options.name,
  });

  return {
    languageModel: (modelId) => provider.chatModel(modelId),
    async generateText(request) {
      const result = await generateText({
        model: provider.chatModel(request.modelId),
        ...(request.system === undefined ? {} : { system: request.system }),
        prompt: request.prompt,
        ...(request.temperature === undefined
          ? {}
          : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.abortSignal === undefined
          ? {}
          : { abortSignal: request.abortSignal }),
      });

      return {
        text: result.text,
        usage: result.usage,
        finishReason: result.finishReason,
        rawFinishReason: result.finalStep.rawFinishReason,
        providerMetadata: result.finalStep.providerMetadata,
        performance: result.finalStep.performance,
      };
    },
  };
}
