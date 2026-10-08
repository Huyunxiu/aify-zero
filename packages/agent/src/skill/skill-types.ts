/**
 * The raw front matter of a SKILL.md, kept as it was written. Fields beyond
 * `name` and `description` (allowed-tools, license, metadata, ...) stay here
 * for callers that know what they are looking for.
 */
export type SkillMetadata = Record<string, unknown>;

export type SkillInfo = {
  name: string;
  description: string;
  location: string;
  dir: string;
  content: string;
  category: "global" | "project";
  metadata: SkillMetadata;
};

export type CreateSkillInput = {
  name: string;
  description: string;
  content: string;
  category?: "global" | "project";
  skillDir?: string;
};

export type UpdateSkillInput = Partial<CreateSkillInput> & { name: string };
