import { db, project_table } from "@workspace/db";
import type { ProjectInsertModel } from "@workspace/db";
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

/**
 * 按主目录找项目。`project.primaryDir` 上有唯一索引，写入前先查一次，把
 * 约束冲突变成调用方能读懂的 `PROJECT_DIR_EXISTS`，而不是一个 500。
 */
export async function findProjectByPrimaryDir(primaryDir: string) {
  const [project] = await db
    .select()
    .from(project_table)
    .where(eq(project_table.primaryDir, primaryDir))
    .limit(1);
  return project ?? null;
}

export async function createProject(data: ProjectInsertModel) {
  const [project] = await db.insert(project_table).values(data).returning();
  return project ?? null;
}

export async function updateProject(
  id: string,
  data: Partial<ProjectInsertModel>
) {
  await db
    .update(project_table)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(project_table.id, id));
  return await findProjectById(id);
}
