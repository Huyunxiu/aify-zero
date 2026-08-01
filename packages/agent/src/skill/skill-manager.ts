import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { glob } from "glob";
import matter from "gray-matter";

import { SkillMetadataSchema } from "./skill-types";
import type { SkillInfo } from "./skill-types";

export const SKILL_DIRS = [".claude", ".agents", ".aify-studio"];
export const SKILL_PATTERN = "skills/**/SKILL.md";

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
        category: "personal" as const,
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

          const metadataResult = SkillMetadataSchema.safeParse(parsed.data);
          if (!metadataResult.success) {
            console.warn(
              "[skill.scan] Invalid skill metadata:",
              location,
              metadataResult.error.issues
            );
            continue;
          }

          skills.push({
            name: metadataResult.data.name,
            description: metadataResult.data.description,
            location,
            content: parsed.content,
            category: level.category,
            metadata: metadataResult.data,
          });
        }
      }
    }

    return skills;
  }

  query(filters?: {
    name?: string;
    category?: "personal" | "project";
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
    return this.skills.find((skill) => skill.name === name);
  }

  getAll(): SkillInfo[] {
    return this.skills;
  }

  appendPrompt(prompt: string): string {
    const skills = this.getAll();
    const skillPrompt = [
      "",
      "## Available Skills",
      ...skills.map((skill) => `- **${skill.name}**: ${skill.description}`),
    ].join("\n");
    return prompt + skillPrompt;
  }
}
