import { SKILL_DIRS, SkillManager } from "@workspace/agent/skill/index";

import { PRIMARY_PROJECT_DIR } from "../../config";
import { publicProcedure } from "../../index";

// GET /skills — list all skills
const list = publicProcedure
  .route({ method: "GET", path: "/skills" })
  .handler(async () => {
    const projectDir = PRIMARY_PROJECT_DIR;
    const skillManager = new SkillManager({ dirs: SKILL_DIRS });
    await skillManager.loadSkills(projectDir);
    return {
      data: skillManager.listUserAvailableSkills(),
    };
  });

export const skill = {
  list,
};
