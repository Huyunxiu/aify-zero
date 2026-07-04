import z from "zod";

export const createAiModelSchema = z.object({
  id: z.string().max(255),
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  compatibleType: z.string().min(1),
  supports: z.record(z.string(), z.unknown()),
  active: z.boolean().default(true),
});

export const updateAiModelSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  compatibleType: z.string().min(1).optional(),
  supports: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
});

export const getAiModelSchema = z.object({
  id: z.string(),
});
