import z from "zod";

export const createAiModelSchema = z.object({
  id: z.string().max(255),
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  apiUrl: z.string().min(1),
  apiKey: z.string().min(1),
  compatibleType: z.templateLiteral(["openai"]),
  active: z.boolean().default(true),
});

export const updateAiModelSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiUrl: z.string().min(1),
  apiKey: z.string().min(1),
  compatibleType: z.templateLiteral(["openai"]).optional(),
  active: z.boolean().optional(),
});

export const getAiModelSchema = z.object({
  id: z.string(),
});
