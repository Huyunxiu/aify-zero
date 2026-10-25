import { session_table, db, turn_table } from "@workspace/db";
import type {
  SessionInsertModel,
  SessionModel,
  TurnInsertModel,
  TurnModel,
} from "@workspace/db";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";

import type { AgentStore, SessionEndStatus } from ".";

export class SQLiteStore implements AgentStore {
  async listSessions({
    cursor,
    limit,
    direction,
    kind,
    projectId,
  }: {
    cursor?: string;
    limit?: number;
    direction?: "asc" | "desc";
    kind: SessionModel["kind"];
    projectId?: string;
  }): Promise<SessionModel[]> {
    const isDesc = direction === "desc";
    // kind 是常驻条件，游标是附加的：少了 kind，子 agent 的行会挤进分页结果，
    // 调用方按"返回条数 == pageSize"推下一页时跟着一起错。
    const conditions = [
      eq(session_table.kind, kind),
      ...(projectId ? [eq(session_table.projectId, projectId)] : []),
      ...(cursor
        ? [isDesc ? lt(session_table.id, cursor) : gt(session_table.id, cursor)]
        : []),
    ];

    const sessions = await db
      .select()
      .from(session_table)
      .where(and(...conditions))
      .orderBy(
        isDesc ? desc(session_table.createdAt) : asc(session_table.createdAt)
      )
      .limit(limit ?? 20);

    return sessions;
  }

  async findSessionByParentToolCall({
    parentSessionId,
    toolCallId,
  }: {
    parentSessionId: string;
    toolCallId: string;
  }): Promise<SessionModel | null> {
    const [session] = await db
      .select()
      .from(session_table)
      .where(
        and(
          eq(session_table.parentSessionId, parentSessionId),
          eq(session_table.parentToolCallId, toolCallId)
        )
      )
      .limit(1);

    return session ?? null;
  }

  async listChildSessions(parentSessionId: string): Promise<SessionModel[]> {
    const sessions = await db
      .select()
      .from(session_table)
      .where(eq(session_table.parentSessionId, parentSessionId));

    return sessions;
  }

  async saveSession(session: SessionInsertModel): Promise<boolean> {
    const result = await db.insert(session_table).values(session);
    return result.rowsAffected > 0;
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

    const finalTurns = turns || (await this.getAllTurnsBySessionId(sessionId));
    const turnsMap = new Map(finalTurns.map((turn) => [turn.id, turn]));

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

  async setActiveStream(sessionId: string, streamId: string): Promise<number> {
    const result = await db
      .update(session_table)
      .set({ activeStreamId: streamId, status: "running" })
      .where(eq(session_table.id, sessionId));
    return result.rowsAffected;
  }

  async clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus
  ): Promise<number> {
    // Compare-and-clear: a stream that has already been superseded leaves the
    // newer stream's marker alone.
    const result = await db
      .update(session_table)
      .set({ activeStreamId: null, status })
      .where(
        and(
          eq(session_table.id, sessionId),
          eq(session_table.activeStreamId, streamId)
        )
      );
    return result.rowsAffected;
  }

  async markSessionRead(sessionId: string): Promise<number> {
    // Guarded on `done`: a session that started a newer turn, or that settled
    // into `canceled`/`error`, must not be walked back to `idle` by a read.
    const result = await db
      .update(session_table)
      .set({ status: "idle" })
      .where(
        and(eq(session_table.id, sessionId), eq(session_table.status, "done"))
      );
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

  async insertTurnInBranch({ turn }: { turn: TurnInsertModel }): Promise<void> {
    // Insert the turn and make it the branch head in one transaction, so a
    // failure cannot leave a dangling row or an active head pointing at
    // nothing. Turns are only appended: a manual compaction records its cut
    // point instead of splicing itself into the middle of the branch.
    await db.transaction(async (tx) => {
      await tx.insert(turn_table).values(turn);

      if (turn.sessionId) {
        await tx
          .update(session_table)
          .set({ activeHeadId: turn.id })
          .where(eq(session_table.id, turn.sessionId));
      }
    });
  }

  async updateTurn(
    id: string,
    content: unknown,
    metadata?: unknown
  ): Promise<number> {
    const result = await db
      .update(turn_table)
      .set({ content, metadata })
      .where(eq(turn_table.id, id));
    return result.rowsAffected;
  }
}
