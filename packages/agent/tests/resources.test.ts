import { describe, expect, test, vi } from "vitest";

import type { ContextFile } from "../src/context-files.js";
import { loadContextFiles } from "../src/resources/load-context-files.js";
import { loadSkills } from "../src/resources/load-skills.js";
import type { ContextSource, SkillSource } from "../src/resources/types.js";
import { SkillManager } from "../src/skill/skill-manager.js";
import type { SkillInfo, SkillSourceKind } from "../src/skill/skill-types.js";

const context = { workdir: "/repo" };

const makeSkill = (
  name: string,
  category: "global" | "project",
  options: {
    dir?: string;
    priority?: number;
    source?: SkillSourceKind;
  } = {}
): SkillInfo => {
  const dir = options.dir ?? ".agents";
  return {
    name,
    description: `${name} description`,
    location: `${category}/${dir}/skills/${name}/SKILL.md`,
    dir,
    content: "",
    category,
    metadata: {},
    source: options.source ?? "filesystem",
    priority: options.priority,
  };
};

const skillSource = (skills: SkillInfo[]): SkillSource => ({
  load: () => Promise.resolve(skills),
});

const contextSource = (files: ContextFile[]): ContextSource => ({
  load: () => Promise.resolve(files),
});

const managerWith = (skills: SkillInfo[]): SkillManager =>
  SkillManager.fromSkills(skills, { dirs: [".aify-studio", ".agents"] });

describe(loadSkills, () => {
  test("assigns source order as priority and keeps an explicit one", async () => {
    const skills = await loadSkills(
      [
        skillSource([makeSkill("first", "global")]),
        skillSource([makeSkill("second", "global", { priority: 7 })]),
      ],
      context
    );

    expect(skills.map((skill) => skill.priority)).toStrictEqual([0, 7]);
  });

  test("keeps loading the other sources when one fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: SkillSource = {
      load: () => Promise.reject(new Error("database down")),
    };

    const skills = await loadSkills(
      [failing, skillSource([makeSkill("survivor", "global")])],
      context
    );

    expect(skills.map((skill) => skill.name)).toStrictEqual(["survivor"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skill source 0"),
      expect.any(Error)
    );
    warn.mockRestore();
  });
});

describe("SkillManager.fromSkills", () => {
  test("lets a project skill shadow a global one from a later source", async () => {
    const skills = await loadSkills(
      [
        skillSource([makeSkill("shared", "global")]),
        skillSource([makeSkill("shared", "project", { source: "database" })]),
      ],
      context
    );

    const winners = managerWith(skills).listUserAvailableSkills();
    expect(winners).toHaveLength(1);
    expect(winners[0]?.source).toBe("database");
  });

  test("lets an earlier source win within the same scope", async () => {
    const skills = await loadSkills(
      [
        skillSource([makeSkill("shared", "project", { source: "database" })]),
        skillSource([makeSkill("shared", "project")]),
      ],
      context
    );

    const winners = managerWith(skills).listUserAvailableSkills();
    expect(winners).toHaveLength(1);
    expect(winners[0]?.source).toBe("database");
  });

  test("honors an explicit priority over source order", async () => {
    const skills = await loadSkills(
      [
        skillSource([
          makeSkill("shared", "project", {
            source: "database",
            priority: 5,
          }),
        ]),
        skillSource([makeSkill("shared", "project")]),
      ],
      context
    );

    const winners = managerWith(skills).listUserAvailableSkills();
    expect(winners[0]?.priority).toBe(1);
  });
});

describe(loadContextFiles, () => {
  test("concatenates sources in the given order", async () => {
    const files = await loadContextFiles(
      [
        contextSource([
          { path: "/global/AGENTS.md", content: "global" },
          { path: "/repo/AGENTS.md", content: "repo" },
        ]),
        contextSource([{ path: "db://AGENTS.md", content: "database" }]),
      ],
      context
    );

    expect(files.map((file) => file.path)).toStrictEqual([
      "/global/AGENTS.md",
      "/repo/AGENTS.md",
      "db://AGENTS.md",
    ]);
  });

  test("lets a later source replace content at the same path", async () => {
    const files = await loadContextFiles(
      [
        contextSource([
          { path: "/a.md", content: "a from file" },
          { path: "/b.md", content: "b from file" },
        ]),
        contextSource([
          { path: "/b.md", content: "b from database" },
          { path: "/c.md", content: "c from database" },
        ]),
      ],
      context
    );

    expect(files).toStrictEqual([
      { path: "/a.md", content: "a from file" },
      { path: "/b.md", content: "b from database" },
      { path: "/c.md", content: "c from database" },
    ]);
  });

  test("keeps loading the other sources when one fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: ContextSource = {
      load: () => Promise.reject(new Error("database down")),
    };

    const files = await loadContextFiles(
      [failing, contextSource([{ path: "/repo/AGENTS.md", content: "repo" }])],
      context
    );

    expect(files).toStrictEqual([{ path: "/repo/AGENTS.md", content: "repo" }]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("context source 0"),
      expect.any(Error)
    );
    warn.mockRestore();
  });
});
