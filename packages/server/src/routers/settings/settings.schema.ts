import z from "zod";

export const userSettingsSchema = z.object({
  /** UI theme preference */
  theme: z.enum(["light", "dark", "system"]).default("system"),
  /** Interface language */
  language: z.string().default("en-US"),
  /** Default AI model ID to use */
  defaultModel: z.string().default(""),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const updateUserSettingsSchema = userSettingsSchema.partial();
