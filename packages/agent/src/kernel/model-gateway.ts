import type { ModelProtocol, ModelRef } from "@workspace/shared/model";
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
  readonly prompt: string;
  readonly system?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly abortSignal?: AbortSignal;
}

/**
 * 一次模型调用的目标：供应商那一侧的接入信息，加上要用的模型。
 *
 * 它由宿主的设置解析而来，`packages/agent` 只声明形状。
 */
export interface ModelTarget {
  readonly ref: ModelRef;
  /** 供应商名字，出现在请求头和事件里。 */
  readonly name: string;
  readonly protocol: ModelProtocol;
  readonly baseURL: string;
  readonly apiKey: string;
  /** 供应商自带的自定义请求头。 */
  readonly headers?: Readonly<Record<string, string>>;
}

/** 把模型引用解析成调用目标；没配置时返回 `undefined`。 */
export type ModelTargetResolver = (ref: ModelRef) => ModelTarget | undefined;

/**
 * 模型调用的端口。
 *
 * 内核和扩展都通过它拿模型、发一次性的文本生成请求；具体连哪家供应商、用
 * 什么协议和鉴权是组合根的事。
 *
 * 入参是模型引用而不是裸 id：运行中的补丁可以把模型换到另一家供应商，地址
 * 和密钥必须跟着换。
 */
export interface ModelGateway {
  languageModel(ref: ModelRef): LanguageModel;
  generateText(
    ref: ModelRef,
    request: GenerateTextRequest
  ): Promise<GeneratedText>;
}
