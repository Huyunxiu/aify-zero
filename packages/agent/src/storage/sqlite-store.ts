import { session_table, db, message_table } from "@workspace/db";
import type {
  SessionInsertModel,
  SessionModel,
  MessageInsertModel,
  MessageModel,
} from "@workspace/db";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";

import type { AgentStore } from ".";

export class SQLiteStore implements AgentStore {
  async listSessions({
    cursor,
    limit,
    direction,
  }: {
    cursor?: string;
    limit?: number;
    direction?: "asc" | "desc";
  }): Promise<SessionModel[]> {
    const isDesc = direction === "desc";
    const whereConditions = cursor
      ? [isDesc ? lt(session_table.id, cursor) : gt(session_table.id, cursor)]
      : [];

    const sessions = await db
      .select()
      .from(session_table)
      .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
      .orderBy(
        isDesc ? desc(session_table.createdAt) : asc(session_table.createdAt)
      )
      .limit(limit ?? 20);

    return sessions;
  }

  async saveSession(session: SessionInsertModel): Promise<boolean> {
    const result = await db.insert(session_table).values(session);
    return result.rowsAffected > 0;
  }

  async updateSession(sessionId: string, title: string): Promise<number> {
    const result = await db
      .update(session_table)
      .set({ title })
      .where(eq(session_table.id, sessionId));
    return result.rowsAffected;
  }

  async getSessionById(sessionId: string): Promise<SessionModel | null> {
    const [session] = await db
      .select()
      .from(session_table)
      .where(eq(session_table.id, sessionId))
      .limit(1);
    if (!session) {
      return null;
    }

    return session;
  }

  async updateSessionById(sessionId: string, title: string): Promise<number> {
    const result = await db
      .update(session_table)
      .set({ title })
      .where(eq(session_table.id, sessionId));
    return result.rowsAffected;
  }

  async getMessagesBySessionId(sessionId: string): Promise<MessageModel[]> {
    return await db
      .select()
      .from(message_table)
      .where(eq(message_table.sessionId, sessionId))
      .orderBy(asc(message_table.createdAt));
  }

  async existsMessages(id: string): Promise<boolean> {
    const result = await db
      .select({ count: count() })
      .from(message_table)
      .where(eq(message_table.id, id));
    return (result[0]?.count ?? 0) > 0;
  }

  async saveMessage(message: MessageInsertModel): Promise<number> {
    const result = await db.insert(message_table).values(message);
    return result.rowsAffected;
  }

  async saveMessages(messages: MessageInsertModel[]): Promise<number> {
    const result = await db.insert(message_table).values(messages);
    return result.rowsAffected;
  }

  async updateMessage(
    id: string,
    content: unknown,
    metadata: unknown
  ): Promise<number> {
    const result = await db
      .update(message_table)
      .set({ content, metadata })
      .where(eq(message_table.id, id));
    return result.rowsAffected;
  }
}
