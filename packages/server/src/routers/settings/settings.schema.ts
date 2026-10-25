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

export const userSettingsSchema = z.object({
  /** UI theme preference */
  theme: z.enum(["light", "dark", "system"]).default("system"),
  /** Interface language */
  language: z.string().default("en-US"),
  /** Default AI model ID to use */
  defaultModel: z.string().default(""),
  /** Configured AI models */
  models: z.array(aiModelSchema).default([]),
  /** 上下文压缩；默认开启，并使用保守的预算。 */
  compaction: compactionSettingsSchema.default({
    auto: true,
    thresholdRatio: 0.8,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    pruneToolResults: true,
    maxSummaryTokens: 8192,
  }),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const updateUserSettingsSchema = userSettingsSchema.partial();
