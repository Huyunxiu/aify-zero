import { z } from "zod";

export const SkillMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
});

export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

export const skillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  content: z.string(),
  category: z.enum(["personal", "project"]),
  metadata: SkillMetadataSchema,
});

export type SkillInfo = z.infer<typeof skillInfoSchema>;

export type CreateSkillInput = {
  name: string;
  description: string;
  content: string;
  category?: "personal" | "project";
  skillDir?: string;
};

export type UpdateSkillInput = Partial<CreateSkillInput> & { name: string };
