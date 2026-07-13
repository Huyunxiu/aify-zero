import { db, dict_table } from "@workspace/db";
import type { DictInsertModel } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function findDictByCode(code: string) {
  const [result] = await db
    .select()
    .from(dict_table)
    .where(eq(dict_table.code, code))
    .limit(1);
  return result ?? null;
}

export async function createDict(data: DictInsertModel) {
  await db.insert(dict_table).values(data);
  return await findDictByCode(data.code);
}

export async function listDicts() {
  return await db.select().from(dict_table);
}

export async function updateDict(code: string, data: Partial<DictInsertModel>) {
  await db.update(dict_table).set(data).where(eq(dict_table.code, code));
  return await findDictByCode(code);
}

export async function deleteDict(code: string) {
  const dict = await findDictByCode(code);
  if (!dict) {
    return null;
  }
  await db.delete(dict_table).where(eq(dict_table.code, code));
  return dict;
}
