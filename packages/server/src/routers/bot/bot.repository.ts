import { DEFAULT_BOT_ID } from "@workspace/agent-client";
import { bot_table, db } from "@workspace/db";
import type { BotInsertModel, BotModel } from "@workspace/db";
import { and, asc, eq, isNull } from "drizzle-orm";

/** Find one active (non-deleted) Bot by ID. */
export async function findBotById(id: string): Promise<BotModel | null> {
  const [bot] = await db
    .select()
    .from(bot_table)
    .where(and(eq(bot_table.id, id), isNull(bot_table.deletedAt)))
    .limit(1);
  return bot ?? null;
}

/** Find any Bot row by ID, including soft-deleted rows. */
export async function findBotRowById(id: string): Promise<BotModel | null> {
  const [bot] = await db
    .select()
    .from(bot_table)
    .where(eq(bot_table.id, id))
    .limit(1);
  return bot ?? null;
}

/** List all active Bots with the Default Bot pinned first, followed by creation order. */
export async function listActiveBots(): Promise<BotModel[]> {
  const rows = await db
    .select()
    .from(bot_table)
    .where(isNull(bot_table.deletedAt))
    .orderBy(asc(bot_table.createdAt), asc(bot_table.id));

  return rows.toSorted((a, b) => {
    if (a.id === DEFAULT_BOT_ID && b.id !== DEFAULT_BOT_ID) {
      return -1;
    }
    if (b.id === DEFAULT_BOT_ID && a.id !== DEFAULT_BOT_ID) {
      return 1;
    }
    return 0;
  });
}

export async function insertBot(values: BotInsertModel): Promise<BotModel> {
  const [created] = await db
    .insert(bot_table)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const existing = await findBotRowById(values.id ?? "");
    if (existing) {
      return existing;
    }
    throw new Error("Bot insert did not produce a row.");
  }
  return created;
}

export async function updateBotRow(
  id: string,
  patch: Partial<BotInsertModel>
): Promise<BotModel | null> {
  const [updated] = await db
    .update(bot_table)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(bot_table.id, id), isNull(bot_table.deletedAt)))
    .returning();
  return updated ?? null;
}

export async function softDeleteBotRow(
  id: string,
  deletedAt: Date
): Promise<boolean> {
  const claimed = await db
    .update(bot_table)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(and(eq(bot_table.id, id), isNull(bot_table.deletedAt)))
    .returning({ id: bot_table.id });
  return claimed.length > 0;
}
