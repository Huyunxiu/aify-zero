import { db, project_table } from "@workspace/db";
import { asc, eq } from "drizzle-orm";

/** 全部项目，按名称排序，侧边栏按这个顺序展示。 */
export async function listProjects() {
  return await db.select().from(project_table).orderBy(asc(project_table.name));
}

export async function findProjectById(id: string) {
  const [project] = await db
    .select()
    .from(project_table)
    .where(eq(project_table.id, id))
    .limit(1);
  return project ?? null;
}
