import { homedir } from "node:os";

import { SKILL_DIRS, SkillManager } from "@workspace/agent/skill/index";

import { publicProcedure } from "../../index";

// GET /skills — list all skills
const list = publicProcedure
  .route({ method: "GET", path: "/skills" })
  .handler(async () => {
    const workdir = homedir();
    const skillManager = new SkillManager({ dirs: SKILL_DIRS });
    await skillManager.loadSkills(workdir);
    return {
      data: skillManager.listAll(),
    };
  });

export const skill = {
  list,
};
