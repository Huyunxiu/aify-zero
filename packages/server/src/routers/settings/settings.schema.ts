import z from "zod";

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
});

export type AiModel = z.infer<typeof aiModelSchema>;

export const userSettingsSchema = z.object({
  /** UI theme preference */
  theme: z.enum(["light", "dark", "system"]).default("system"),
  /** Interface language */
  language: z.string().default("en-US"),
  /** Default AI model ID to use */
  defaultModel: z.string().default(""),
  /** Configured AI models */
  models: z.array(aiModelSchema).default([]),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const updateUserSettingsSchema = userSettingsSchema.partial();
