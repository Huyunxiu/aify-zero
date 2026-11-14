import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelRef } from "@workspace/shared/model";
import { generateText } from "ai";
import type { LanguageModel } from "ai";

import type {
  GenerateTextRequest,
  GeneratedText,
  ModelGateway,
  ModelTarget,
  ModelTargetResolver,
} from "../kernel/model-gateway";
import { withOpencodeHeaders } from "./opencode";

export interface ModelGatewayOptions {
  /** 由宿主按设置解析：引用 → 供应商的接入信息。 */
  resolve: ModelTargetResolver;
  /** 会话 id；OpenCode 的网关按它路由。 */
  sessionId: string;
  /** 会话主目录；OpenCode 的网关要求带上。 */
  projectDir?: string;
}

/**
 * 按协议构造模型的 {@link ModelGateway}。
 *
 * 适配器只做协议转换，不缓存模型对象：同一次 turn 可能因为补丁换模型，缓存
 * 会把换模型变成隐式失败。
 */
export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const resolve = (ref: ModelRef): ModelTarget => {
    const target = options.resolve(ref);
    if (!target) {
      throw new Error(
        `model is not configured: ${ref.providerId}/${ref.modelId}`
      );
    }
    return target;
  };

  const headersOf = (target: ModelTarget): Record<string, string> =>
    withOpencodeHeaders({
      baseURL: target.baseURL,
      sessionId: options.sessionId,
      projectDir: options.projectDir,
      headers: target.headers,
    });

  const languageModel = (ref: ModelRef): LanguageModel => {
    const target = resolve(ref);
    const settings = {
      apiKey: target.apiKey,
      baseURL: target.baseURL,
      name: target.name,
      headers: headersOf(target),
    };

    return target.protocol === "openai-responses"
      ? createOpenAI(settings).responses(ref.modelId)
      : createOpenAICompatible(settings).chatModel(ref.modelId);
  };

  return {
    languageModel,
    async generateText(
      ref: ModelRef,
      request: GenerateTextRequest
    ): Promise<GeneratedText> {
      const result = await generateText({
        model: languageModel(ref),
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
