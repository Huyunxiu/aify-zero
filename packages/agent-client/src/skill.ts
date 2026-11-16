/**
 * The raw front matter of a SKILL.md, kept as it was written. Fields beyond
 * `name` and `description` (allowed-tools, license, metadata, ...) stay here
 * for callers that know what they are looking for.
 */
export type SkillMetadata = Record<string, unknown>;

/** 技能从哪里加载。以后接数据库时用 `database`，不影响排序语义。 */
export type SkillSourceKind = "filesystem" | "database";

export type SkillInfo = {
  name: string;
  description: string;
  location: string;
  dir: string;
  content: string;
  category: "global" | "project";
  metadata: SkillMetadata;
  source: SkillSourceKind;
  /**
   * 来源优先级，数字越小越优先。加载器按 source 顺序写入；数据源可以显式
   * 覆盖，让数据库记录排到文件系统前面。
   */
  priority?: number;
};

export type CreateSkillInput = {
  name: string;
  description: string;
  content: string;
  category?: "global" | "project";
  skillDir?: string;
};

export type UpdateSkillInput = Partial<CreateSkillInput> & { name: string };
