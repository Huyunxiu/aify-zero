import { SKILL_DIRS, SkillManager } from "@workspace/agent/skill/index";

import { publicProcedure } from "../../index";
import { getPrimaryProjectDir } from "../project/project.service";

// GET /skills — list all skills
const list = publicProcedure
  .route({ method: "GET", path: "/skills" })
  .handler(async () => {
    const projectDir = await getPrimaryProjectDir();
    const skillManager = new SkillManager({ dirs: SKILL_DIRS });
    await skillManager.loadSkills(projectDir);
    return {
      data: skillManager.listUserAvailableSkills(),
    };
  });

export const skill = {
  list,
};
