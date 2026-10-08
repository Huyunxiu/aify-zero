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

  listAll(): SkillInfo[] {
    return this.skills;
  }

  appendPrompt(prompt: string): string {
    const skills = this.listAll();
    const skillPrompt = [
      "",
      "## Available Skills",
      ...skills
        .filter((skill) => !skill.metadata["disable-model-invocation"])
        .map((skill) =>
          skill.description
            ? `- **${skill.name}**: ${skill.description}`
            : `- **${skill.name}**`
        ),
    ].join("\n");
    return prompt + skillPrompt;
  }
}
