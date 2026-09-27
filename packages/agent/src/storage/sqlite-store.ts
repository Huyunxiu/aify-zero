import { session_table, db, turn_table } from "@workspace/db";
import type {
  SessionInsertModel,
  SessionModel,
  TurnInsertModel,
  TurnModel,
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

  async getAllTurnsBySessionId(sessionId: string): Promise<TurnModel[]> {
    return await db
      .select()
      .from(turn_table)
      .where(eq(turn_table.sessionId, sessionId))
      .orderBy(asc(turn_table.createdAt), asc(turn_table.id));
  }

  async getBranchTurns(
    sessionId: string,
    turns?: TurnModel[]
  ): Promise<TurnModel[]> {
    const session = await this.getSessionById(sessionId);
    if (!session?.activeHeadId) {
      return [];
    }

    turns ||= await this.getAllTurnsBySessionId(sessionId);
    const turnsMap = new Map(turns.map((message) => [message.id, message]));

    const path: TurnModel[] = [];
    let current = turnsMap.get(session.activeHeadId);
    while (current) {
      path.unshift(current);
      turnsMap.delete(current.id);
      current = current.parentId ? turnsMap.get(current.parentId) : undefined;
    }
    return path;
  }

  async setActiveHead(
    sessionId: string,
    messageId: string | undefined
  ): Promise<number> {
    const result = await db
      .update(session_table)
      .set({ activeHeadId: messageId })
      .where(eq(session_table.id, sessionId));
    return result.rowsAffected;
  }

  async existsTurn(id: string): Promise<boolean> {
    const result = await db
      .select({ count: count() })
      .from(turn_table)
      .where(eq(turn_table.id, id));
    return (result[0]?.count ?? 0) > 0;
  }

  async saveTurn(message: TurnInsertModel): Promise<number> {
    // Upsert: client resends existing message ids on regenerate; only
    // content/metadata change in that case — parentId keeps its original
    // branch position.
    const result = await db
      .insert(turn_table)
      .values(message)
      .onConflictDoUpdate({
        target: turn_table.id,
        set: {
          content: message.content,
          metadata: message.metadata,
          updatedAt: new Date(),
        },
      });
    return result.rowsAffected;
  }

  async saveTurns(messages: TurnInsertModel[]): Promise<number> {
    const result = await db.insert(turn_table).values(messages);
    return result.rowsAffected;
  }

  async updateTurn(
    id: string,
    content: unknown,
    metadata: unknown
  ): Promise<number> {
    const result = await db
      .update(turn_table)
      .set({ content, metadata })
      .where(eq(turn_table.id, id));
    return result.rowsAffected;
  }
}
