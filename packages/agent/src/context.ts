import z from "zod";

import type { SkillManager } from "./skill";

type AgentContext = {
  workdir: string;
  skills: SkillManager;
} & Record<string, unknown>;

export const CONTEXT_SCHEMA = z.object({
  workdir: z.string(),
});

export type { AgentContext };
