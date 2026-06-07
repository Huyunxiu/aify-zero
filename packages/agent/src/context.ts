import z from "zod";

type AgentContext = {
  workdir: string;
} & Record<string, unknown>;

export const CONTEXT_SCHEMA = z.object({
  workdir: z.string(),
});

export type { AgentContext };
