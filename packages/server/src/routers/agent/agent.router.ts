import { ORPCError } from "@orpc/server";
import { nanoid } from "nanoid";
import z from "zod";

import { publicProcedure } from "../../index";
import {
  createAgent,
  deleteAgent,
  findAgentById,
  listAgents,
  updateAgent,
} from "./agent.repository";
import { agentCreateSchema, agentUpdateSchema } from "./agent.schema";

// POST /agents — create a new agent
const create = publicProcedure
  .route({ method: "POST", path: "/agents" })
  .input(agentCreateSchema)
  .handler(async ({ input }) => {
    const id = nanoid();
    const agent = await createAgent({
      id,
      name: input.name,
      avatar: input.avatar ?? null,
      description: input.description ?? null,
      instructions: input.instructions ?? null,
      tools: input.tools ?? null,
      models: input.models ?? null,
      skills: input.skills ?? null,
      config: input.config ?? null,
    });
    return agent;
  });

// GET /agents — list all agents
const list = publicProcedure
  .route({ method: "GET", path: "/agents" })
  .handler(async () => {
    const agents = await listAgents();
    return {
      agents,
    };
  });

// GET /agents/{agentId} — get a single agent by id
const get = publicProcedure
  .route({ method: "GET", path: "/agents/{agentId}" })
  .input(z.object({ agentId: z.string() }))
  .handler(async ({ input }) => {
    const agent = await findAgentById(input.agentId);
    if (!agent) {
      throw new ORPCError("NOT_FOUND", {
        message: "Agent not found",
      });
    }
    return agent;
  });

// PUT /agents/{agentId} — update an agent
const update = publicProcedure
  .route({ method: "PUT", path: "/agents/{agentId}" })
  .input(
    z.object({
      agentId: z.string(),
      ...agentUpdateSchema.shape,
    })
  )
  .handler(async ({ input }) => {
    const { agentId, ...data } = input;

    const existing = await findAgentById(agentId);
    if (!existing) {
      throw new ORPCError("NOT_FOUND", {
        message: "Agent not found",
      });
    }

    const agent = await updateAgent(agentId, data);
    return agent;
  });

// DELETE /agents/{agentId} — delete an agent
const remove = publicProcedure
  .route({ method: "DELETE", path: "/agents/{agentId}" })
  .input(z.object({ agentId: z.string() }))
  .handler(async ({ input }) => {
    const agent = await deleteAgent(input.agentId);
    if (!agent) {
      throw new ORPCError("NOT_FOUND", {
        message: "Agent not found",
      });
    }
    return agent;
  });

export const agent = {
  create,
  list,
  get,
  update,
  delete: remove,
};
