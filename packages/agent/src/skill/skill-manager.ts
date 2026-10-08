import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { glob } from "glob";
import matter from "gray-matter";

import type { SkillInfo, SkillMetadata } from "./skill-types";

export const SKILL_DIRS = [".aify-studio", ".agents", ".claude"];
export const SKILL_PATTERN = "skills/**/SKILL.md";

/** Front matter can parse to anything; only a mapping carries metadata. */
function toMetadata(data: unknown): SkillMetadata {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {};
  }

  return data as SkillMetadata;
}

/** The trimmed value of a front matter field, when it holds a string. */
function getStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/** A skill paired with the rank that decides where it sits in the lookup order. */
type RankedSkill = { skill: SkillInfo; rank: [number, number] };

/**
 * Where a skill sits in the lookup order: project shadows global, and within
 * one level an earlier directory in `dirs` wins.
 */
function skillRank(skill: SkillInfo, dirs: string[]): [number, number] {
  const level = skill.category === "project" ? 0 : 1;
  const index = dirs.indexOf(skill.dir);
  // A dir outside `dirs` can only come from a hand-built fixture; it ranks last.
  return [level, index === -1 ? dirs.length : index];
}

/**
 * Orders two ranked skills strongest-first: by rank, then by location so that
 * skills of equal rank resolve the same way on every scan.
 */
function compareSkills(a: RankedSkill, b: RankedSkill): number {
  if (a.rank[0] !== b.rank[0]) {
    return a.rank[0] - b.rank[0];
  }
  if (a.rank[1] !== b.rank[1]) {
    return a.rank[1] - b.rank[1];
  }
  return a.skill.location.localeCompare(b.skill.location);
}

export type SkillManagerOptions = {
  dirs: string[];
};

export class SkillManager {
  dirs: string[];

  skills: SkillInfo[];

  constructor(options: SkillManagerOptions) {
    this.dirs = options.dirs;
    this.skills = [];
  }

  async loadSkills(workdir: string) {
    this.skills = await this.scan(workdir);
  }

  async scan(workdir: string): Promise<SkillInfo[]> {
    const levels = [
      {
        category: "global" as const,
        baseDir: homedir(),
      },
      {
        category: "project" as const,
        baseDir: workdir,
      },
    ];

    const skills: SkillInfo[] = [];

    for (const level of levels) {
      for (const dir of this.dirs) {
        const root = path.join(level.baseDir, dir);

        let matches: string[] = [];
        try {
          matches = await glob(SKILL_PATTERN, {
            cwd: root,
            absolute: true,
            nodir: true,
            follow: true,
            dot: true,
          });
        } catch (error) {
          console.warn("[skill.scan] Failed to glob skill files:", root, error);
          continue;
        }

        for (const location of matches) {
          let parsed: matter.GrayMatterFile<string>;
          try {
            const source = await readFile(location, "utf-8");
            parsed = matter(source);
          } catch (error) {
            console.warn(
              "[skill.scan] Failed to read or parse skill file:",
              location,
              error
            );
            continue;
          }

          const metadata = toMetadata(parsed.data);

          skills.push({
            // A skill is identified by its front matter name, or by the
            // directory it lives in when the field is missing.
            name:
              getStringField(metadata.name) ??
              path.basename(path.dirname(location)),
            description: getStringField(metadata.description) ?? "",
            location,
            dir,
            content: parsed.content,
            category: level.category,
            metadata,
          });
        }
      }
    }

    return skills;
  }

  query(filters?: {
    name?: string;
    category?: "global" | "project";
  }): SkillInfo[] {
    let results = [...this.skills];

    const name = filters?.name;
    if (name) {
      results = results.filter((skill) =>
        skill.name.toLowerCase().includes(name.toLowerCase())
      );
    }

    if (filters?.category) {
      results = results.filter((skill) => skill.category === filters.category);
    }

    return results;
  }

  getByName(name: string): SkillInfo | undefined {
    return this.listUserAvailableSkills().find((skill) => skill.name === name);
  }

  listAll(): SkillInfo[] {
    return this.skills;
  }

  /**
   * Every skill the user can reach, one per name. A project skill shadows the
   * global skill of the same name; within one level an earlier directory
   * shadows a later one. Names are compared exactly, so case matters. The
   * result is the strongest-first snapshot of `skills`, not a copy.
   */
  listUserAvailableSkills(): SkillInfo[] {
    const winners = new Map<string, RankedSkill>();

    for (const skill of this.skills) {
      const entry: RankedSkill = { skill, rank: skillRank(skill, this.dirs) };
      const held = winners.get(skill.name);
      if (!held || compareSkills(entry, held) < 0) {
        winners.set(skill.name, entry);
      }
    }

    return [...winners.values()]
      .toSorted(compareSkills)
      .map((entry) => entry.skill);
  }

  /**
   * The subset the model is offered: the skills a user can reach minus those
   * that opt out with `disable-model-invocation`.
   */
  listModelAvailableSkills(): SkillInfo[] {
    return this.listUserAvailableSkills().filter(
      (skill) => !skill.metadata["disable-model-invocation"]
    );
  }

  appendPrompt(prompt: string): string {
    const skillPrompt = [
      "",
      "## Available Skills",
      ...this.listModelAvailableSkills().map((skill) =>
        skill.description
          ? `- **${skill.name}**: ${skill.description}`
          : `- **${skill.name}**`
      ),
    ].join("\n");
    return prompt + skillPrompt;
  }
}
