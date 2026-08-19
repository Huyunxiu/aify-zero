import { db, agent_table } from "@workspace/db";
import type { AgentInsertModel } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function findAgentById(id: string) {
  const [result] = await db
    .select()
    .from(agent_table)
    .where(eq(agent_table.id, id))
    .limit(1);
  return result ?? null;
}

export async function createAgent(data: AgentInsertModel) {
  await db.insert(agent_table).values(data);
  if (!data.id) {
    return null;
  }
  return await findAgentById(data.id);
}

export async function listAgents() {
  return await db.select().from(agent_table);
}

export async function updateAgent(id: string, data: Partial<AgentInsertModel>) {
  await db.update(agent_table).set(data).where(eq(agent_table.id, id));
  return await findAgentById(id);
}

export async function deleteAgent(id: string) {
  const agent = await findAgentById(id);
  if (!agent) {
    return null;
  }
  await db.delete(agent_table).where(eq(agent_table.id, id));
  return agent;
}
