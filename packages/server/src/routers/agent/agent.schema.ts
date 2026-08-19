import z from "zod";

export const agentCreateSchema = z.object({
  name: z.string().min(1, "Agent name is required"),
  avatar: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  models: z.array(z.string()).optional(),
  skills: z.array(z.unknown()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export type AgentCreateInput = z.infer<typeof agentCreateSchema>;

export const agentUpdateSchema = agentCreateSchema.partial();

export type AgentUpdateInput = z.infer<typeof agentUpdateSchema>;
