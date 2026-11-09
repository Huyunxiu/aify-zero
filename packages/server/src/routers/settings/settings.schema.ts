import { mcpServerSchema } from "@workspace/agent/mcp/config";
import z from "zod";

export const Modality = z.enum(["text", "audio", "image", "video", "pdf"]);

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

/** A single AI model configuration */
export const aiModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  apiUrl: z.string(),
  apiKey: z.string(),
  compatibleType: z.templateLiteral(["openai"]),
  active: z.boolean().default(true),
  reasoning: z.boolean().optional(),
  modalities: Modalities.optional(),
  limit: ModelLimit.optional(),
});

export type AiModel = z.infer<typeof aiModelSchema>;

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
  /** Default AI model ID to use */
  defaultModel: z.string(),
  /** Configured AI models */
  models: z.array(aiModelSchema),
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
  defaultModel: "",
  models: [],
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
