import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SkillManager } from "../src/skill/skill-manager.js";
import type { SkillInfo } from "../src/skill/skill-types.js";

const DIRS = [".agents"];

/** Writes a SKILL.md into `.agents/skills/<skillDir>/` of the workdir. */
const writeSkill = async (
  workdir: string,
  skillDir: string,
  source: string
) => {
  const location = path.join(
    workdir,
    ".agents",
    "skills",
    skillDir,
    "SKILL.md"
  );
  await mkdir(path.dirname(location), { recursive: true });
  await writeFile(location, source);
};

/**
 * Scans the workdir only: `scan` walks the real home directory too, and the
 * skills living there are none of this test's business.
 */
const scanWorkdir = async (workdir: string): Promise<SkillInfo[]> => {
  const manager = new SkillManager({ dirs: DIRS });
  const skills = await manager.scan(workdir);
  return skills.filter((skill) => skill.location.startsWith(workdir));
};

describe(SkillManager, () => {
  let workdir = "";

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "skill-manager-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  describe("scan", () => {
    test("should keep every front matter field as metadata", async () => {
      await writeSkill(
        workdir,
        "vercel-react-best-practices",
        [
          "---",
          "name: vercel-react-best-practices",
          "description: React and Next.js performance rules.",
          "license: MIT",
          "allowed-tools: Read, Grep",
          "user-invocable: false",
          "metadata:",
          "  author: vercel",
          '  version: "1.0.0"',
          "---",
          "",
          "# Body",
          "",
        ].join("\n")
      );

      const [skill] = await scanWorkdir(workdir);

      expect(skill).toMatchObject({
        name: "vercel-react-best-practices",
        description: "React and Next.js performance rules.",
        dir: ".agents",
        category: "project",
        content: "\n# Body\n",
      });
      expect(skill?.metadata).toStrictEqual({
        name: "vercel-react-best-practices",
        description: "React and Next.js performance rules.",
        license: "MIT",
        "allowed-tools": "Read, Grep",
        "user-invocable": false,
        metadata: { author: "vercel", version: "1.0.0" },
      });
    });

    test("should fall back to the skill directory name", async () => {
      await writeSkill(
        workdir,
        "plain",
        "---\ndescription: No name here.\n---\nBody\n"
      );

      const [skill] = await scanWorkdir(workdir);

      expect(skill?.name).toBe("plain");
      expect(skill?.description).toBe("No name here.");
    });

    test("should load a skill without front matter", async () => {
      await writeSkill(workdir, "bare", "# Just a body\n");

      const [skill] = await scanWorkdir(workdir);

      expect(skill).toMatchObject({
        name: "bare",
        description: "",
        metadata: {},
      });
    });

    test("should ignore front matter that is not a mapping", async () => {
      await writeSkill(workdir, "scalar", "---\n42\n---\nBody\n");

      const [skill] = await scanWorkdir(workdir);

      expect(skill?.name).toBe("scalar");
      expect(skill?.metadata).toStrictEqual({});
    });
  });

  describe("appendPrompt", () => {
    test("should list a skill without a description by name only", async () => {
      await writeSkill(workdir, "plain", "# Just a body\n");
      const manager = new SkillManager({ dirs: DIRS });
      await manager.loadSkills(workdir);

      const lines = manager.appendPrompt("base").split("\n");

      expect(lines).toContain("- **plain**");
    });
  });
});
