import { ai_model_table, db } from "@workspace/db";
import type { AiModelInsertModel } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function findAiModelById(id: string) {
  const [result] = await db
    .select()
    .from(ai_model_table)
    .where(eq(ai_model_table.id, id))
    .limit(1);
  return result ?? null;
}

export async function createAiModel(data: AiModelInsertModel) {
  await db.insert(ai_model_table).values(data);
  return await findAiModelById(data.id);
}

export async function listAiModels() {
  return await db.select().from(ai_model_table);
}

export async function updateAiModel(
  id: string,
  data: Partial<AiModelInsertModel>
) {
  await db.update(ai_model_table).set(data).where(eq(ai_model_table.id, id));
  return await findAiModelById(id);
}

export async function deleteAiModel(id: string) {
  const model = await findAiModelById(id);
  if (!model) {
    return null;
  }
  await db.delete(ai_model_table).where(eq(ai_model_table.id, id));
  return model;
}
