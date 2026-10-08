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

/** The directories that decide precedence, in the order they are searched. */
const ALL_DIRS = [".aify-studio", ".agents", ".claude"];

/**
 * A skill shaped the way `scan` hands it over, for the tests that build their
 * own set instead of scanning one: the global level is pinned to `homedir()`,
 * so a project-over-global shadowing cannot be set up on a temp workdir.
 */
const makeSkill = (
  name: string,
  category: "global" | "project",
  dir: string,
  metadata: Record<string, unknown> = {}
): SkillInfo => ({
  name,
  description: `${name} description`,
  location: `${category}/${dir}/skills/${name}/SKILL.md`,
  dir,
  content: "",
  category,
  metadata,
});

/** A manager holding the given skills, as if they had just been scanned. */
const managerWith = (...skills: SkillInfo[]): SkillManager => {
  const manager = new SkillManager({ dirs: ALL_DIRS });
  manager.skills = skills;
  return manager;
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

    test("should collapse one name found in two directories to the earlier one", async () => {
      const dirs = [".aify-studio", ".agents"];
      const write = async (dir: string, description: string) => {
        const location = path.join(workdir, dir, "skills", "dup", "SKILL.md");
        await mkdir(path.dirname(location), { recursive: true });
        await writeFile(
          location,
          `---\nname: dup\ndescription: ${description}\n---\nBody\n`
        );
      };
      await write(".aify-studio", "From .aify-studio.");
      await write(".agents", "From .agents.");

      const manager = new SkillManager({ dirs });
      await manager.loadSkills(workdir);
      const skills = manager
        .listUserAvailableSkills()
        .filter((skill) => skill.location.startsWith(workdir));

      expect(skills).toHaveLength(1);
      expect(skills[0]?.dir).toBe(".aify-studio");
      expect(skills[0]?.description).toBe("From .aify-studio.");
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

    test("should keep the line format of a plain list", () => {
      const manager = managerWith(makeSkill("alpha", "global", ".agents"), {
        ...makeSkill("plain", "global", ".agents"),
        description: "",
      });

      expect(manager.appendPrompt("base")).toBe(
        "base\n## Available Skills\n- **alpha**: alpha description\n- **plain**"
      );
    });

    test("should list a shadowed skill once, from the project copy", () => {
      const manager = managerWith(
        makeSkill("dup", "global", ".agents"),
        makeSkill("dup", "project", ".agents")
      );

      const lines = manager
        .appendPrompt("base")
        .split("\n")
        .filter((line) => line.startsWith("- "));

      expect(lines).toStrictEqual(["- **dup**: dup description"]);
    });

    test("should keep the heading when every skill opts out", () => {
      const manager = managerWith(
        makeSkill("off", "global", ".agents", {
          "disable-model-invocation": true,
        })
      );

      expect(manager.appendPrompt("base")).toBe("base\n## Available Skills");
    });
  });

  describe("listUserAvailableSkills", () => {
    test("should let a project skill shadow the global one of the same name", () => {
      const globalSkill = makeSkill("dup", "global", ".aify-studio");
      const projectSkill = makeSkill("dup", "project", ".claude");

      // The project copy wins even from the last directory in the search order.
      expect(
        managerWith(globalSkill, projectSkill).listUserAvailableSkills()
      ).toStrictEqual([projectSkill]);
    });

    test("should let an earlier directory shadow a later one of the same level", () => {
      const earlier = makeSkill("dup", "global", ".aify-studio");
      const later = makeSkill("dup", "global", ".claude");

      expect(
        managerWith(later, earlier).listUserAvailableSkills()
      ).toStrictEqual([earlier]);
    });

    test("should let an earlier directory shadow a later one of a project", () => {
      const earlier = makeSkill("dup", "project", ".aify-studio");
      const later = makeSkill("dup", "project", ".claude");

      expect(
        managerWith(later, earlier).listUserAvailableSkills()
      ).toStrictEqual([earlier]);
    });

    test("should compare names exactly, so case separates two skills", () => {
      const upper = makeSkill("Foo", "global", ".agents");
      const lower = makeSkill("foo", "global", ".agents");

      const skills = managerWith(upper, lower).listUserAvailableSkills();

      expect(skills).toHaveLength(2);
      expect(skills).toStrictEqual(expect.arrayContaining([upper, lower]));
    });

    test("should keep every unique name, strongest first", () => {
      const globalSkill = makeSkill("alpha", "global", ".aify-studio");
      const projectSkill = makeSkill("beta", "project", ".claude");

      expect(
        managerWith(globalSkill, projectSkill).listUserAvailableSkills()
      ).toStrictEqual([projectSkill, globalSkill]);
    });

    test("should settle a full tie by location, not by scan order", () => {
      const one = {
        ...makeSkill("dup", "global", ".agents"),
        location: "global/.agents/skills/one/SKILL.md",
      };
      const two = {
        ...makeSkill("dup", "global", ".agents"),
        location: "global/.agents/skills/two/SKILL.md",
      };

      expect(managerWith(two, one).listUserAvailableSkills()).toStrictEqual([
        one,
      ]);
    });

    test("should return a skill whose directory is unknown to the manager", () => {
      const stray = makeSkill("stray", "global", ".elsewhere");

      expect(managerWith(stray).listUserAvailableSkills()).toStrictEqual([
        stray,
      ]);
    });
  });

  describe("listModelAvailableSkills", () => {
    test("should drop only the skills that opt out", () => {
      const open = makeSkill("open", "global", ".agents");
      const off = makeSkill("off", "global", ".agents", {
        "disable-model-invocation": true,
      });
      const falseBoolean = makeSkill("false-boolean", "global", ".agents", {
        "disable-model-invocation": false,
      });
      const falseString = makeSkill("false-string", "global", ".agents", {
        "disable-model-invocation": "false",
      });
      const userOnly = makeSkill("user-only", "global", ".agents", {
        "user-invocable": false,
      });

      const manager = managerWith(
        open,
        off,
        falseBoolean,
        falseString,
        userOnly
      );
      const available = manager
        .listModelAvailableSkills()
        .map((skill) => skill.name)
        .toSorted();

      // A quoted "false" is truthy, which is how the front matter reads it.
      expect(available).toStrictEqual(["false-boolean", "open", "user-only"]);
      expect(manager.listUserAvailableSkills()).toHaveLength(5);
    });
  });

  describe("getByName", () => {
    test("should return the project skill that shadows a global one", () => {
      const globalSkill = makeSkill("dup", "global", ".agents");
      const projectSkill = makeSkill("dup", "project", ".agents");

      expect(managerWith(globalSkill, projectSkill).getByName("dup")).toBe(
        projectSkill
      );
    });

    test("should return nothing for an unknown name", () => {
      const manager = managerWith(makeSkill("alpha", "global", ".agents"));

      expect(manager.getByName("absent")).toBeUndefined();
    });
  });
});
