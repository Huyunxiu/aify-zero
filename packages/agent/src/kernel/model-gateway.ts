import type {
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ProviderMetadata,
} from "ai";

/** 一次文本生成的返回值。 */
export interface GeneratedText {
  readonly text: string;
  readonly usage: LanguageModelUsage;
  readonly finishReason: FinishReason;
  readonly rawFinishReason?: string;
  readonly providerMetadata?: ProviderMetadata;
  readonly performance?: unknown;
}

export interface GenerateTextRequest {
  readonly modelId: string;
  readonly prompt: string;
  readonly system?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly abortSignal?: AbortSignal;
}

/**
 * 模型调用的端口。
 *
 * 内核和扩展都通过它拿模型、发一次性的文本生成请求；具体连哪家 provider、
 * 用什么鉴权是组合根的事，不写进 `agents.ts` 之外的调用点。
 *
 * `languageModel` 返回 AI SDK 的模型对象，供 `streamText` 这类需要自己控制
 * 流和工具循环的调用方使用；`generateText` 是后台任务（标题、摘要）用的简化
 * 入口。
 */
export interface ModelGateway {
  languageModel(modelId: string): LanguageModel;
  generateText(request: GenerateTextRequest): Promise<GeneratedText>;
}
