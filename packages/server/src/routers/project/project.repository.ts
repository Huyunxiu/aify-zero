import { db, project_table } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function findProjectById(id: string) {
  const [project] = await db
    .select()
    .from(project_table)
    .where(eq(project_table.id, id))
    .limit(1);
  return project ?? null;
}
