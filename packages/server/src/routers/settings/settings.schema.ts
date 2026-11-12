import { mcpServerSchema } from "@workspace/agent/mcp/config";
import { MODEL_PROTOCOLS } from "@workspace/shared/model";
import z from "zod";

export const Modality = z.enum(["text", "audio", "image", "video", "pdf"]);

export type ModalityName = z.infer<typeof Modality>;

export const Modalities = z
  .object({
    input: z.array(Modality),
    output: z.array(Modality),
  })
  .strict();

const ModelLimit = z
  .object({
    context: z.number().min(0, "Context window must be positive"),
  })
  .strict();

export const modelProtocolSchema = z.enum(MODEL_PROTOCOLS);

/** 唯一确定一个可调用模型的引用。 */
export const modelRefSchema = z
  .object({
    providerId: z.string(),
    modelId: z.string(),
  })
  .strict();

export type ModelRef = z.infer<typeof modelRefSchema>;

/**
 * 供应商下的一个模型。
 *
 * 它只描述模型本身：地址、协议和密钥都属于供应商。
 */
export const providerModelSchema = z.object({
  /** 模型 id：上游用来标识它的字符串，可以自带 `/`。 */
  id: z.string(),
  name: z.string(),
  active: z.boolean().default(true),
  /** 支持推理档位；为假时界面不显示 effort 滑杆。 */
  reasoning: z.boolean().optional(),
  modalities: Modalities.optional(),
  limit: ModelLimit.optional(),
});

export type ProviderModel = z.infer<typeof providerModelSchema>;

/**
 * 一个供应商：接入信息加它提供的模型。
 *
 * 一个供应商只有一种协议；同一家要用两种就配两条。
 */
export const providerSchema = z.object({
  /** slug，不含 `/`。 */
  id: z.string(),
  name: z.string(),
  protocol: modelProtocolSchema,
  baseURL: z.string(),
  apiKey: z.string(),
  /** 额外请求头；OpenCode 一类网关要求的头由网关自己补。 */
  headers: z.record(z.string(), z.string()).optional(),
  active: z.boolean().default(true),
  models: z.array(providerModelSchema),
});

export type Provider = z.infer<typeof providerSchema>;

/** 一次调用要用的完整配置：模型加它所属的供应商。 */
export interface ConfiguredModel {
  ref: ModelRef;
  provider: Provider;
  model: ProviderModel;
}

/** 所有模型共用的上下文压缩策略。 */
export const compactionSettingsSchema = z.object({
  /** 自动压力压缩；手工 `/compact` 始终可用。 */
  auto: z.boolean().default(true),
  thresholdRatio: z.number().min(0.5).max(0.95).default(0.8),
  reserveTokens: z.number().int().min(0).default(16_384),
  keepRecentTokens: z.number().int().min(0).default(20_000),
  pruneToolResults: z.boolean().default(true),
  maxSummaryTokens: z.number().int().min(256).default(8192),
});

export type CompactionSettings = z.infer<typeof compactionSettingsSchema>;

/**
 * 完整的一份设置。
 *
 * 这里故意不给字段写 `.default()`：默认值是「第一次创建」的事，不是「每次
 * 解析」的事。写在这里的话，`partial()` 会把没提交的字段也补成默认值，
 * `{...current, ...input}` 于是把它们清空 —— 保存 MCP 服务器会连带清掉
 * 模型列表，就是这个原因。
 */
export const userSettingsSchema = z.object({
  /** UI theme preference */
  theme: z.enum(["light", "dark", "system"]),
  /** Interface language */
  language: z.string(),
  /** 新会话默认使用的模型；localStorage 里的选择优先。 */
  defaultModel: modelRefSchema.nullable(),
  /** 已配置的供应商，模型内嵌在它们下面。 */
  providers: z.array(providerSchema),
  /** MCP 服务器；连接由进程共享，配置只存在这里。 */
  mcpServers: z.array(mcpServerSchema),
  /** 上下文压缩；默认开启，并使用保守的预算。 */
  compaction: compactionSettingsSchema,
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

/** 第一次创建 `user.settings` 时写入的值。 */
export const USER_SETTINGS_DEFAULTS: UserSettings = {
  theme: "system",
  language: "en-US",
  defaultModel: null,
  providers: [],
  mcpServers: [],
  compaction: {
    auto: true,
    thresholdRatio: 0.8,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    pruneToolResults: true,
    maxSummaryTokens: 8192,
  },
};

/**
 * PATCH 形状。
 *
 * 只带调用方真给了的字段：`.partial()` 之后没有默认值可补，缺的键仍然是
 * `undefined`，合并时不会覆盖已存的设置。
 */
export const updateUserSettingsSchema = userSettingsSchema.partial();
