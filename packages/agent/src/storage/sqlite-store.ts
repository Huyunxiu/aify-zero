import type { AgentTurn } from "@workspace/agent-client";
import { session_table, db, step_table, turn_table } from "@workspace/db";
import type {
  SessionInsertModel,
  SessionModel,
  StepInsertModel,
  StepModel,
  TurnModel,
} from "@workspace/db";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";

import type { AgentStore, SessionEndStatus } from ".";
import {
  hydrateTurn,
  toStepRows,
  toTurnRow,
  turnDetailOf,
} from "./turn-record";
import type { TurnRecord, TurnWrite } from "./turn-record";

/** drizzle 事务回调拿到的句柄；批量写 step 的辅助函数需要它。 */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 按 id upsert 一组 step 行。
 *
 * 冲突时只更新可变列，不碰 `stream_id`：一个 step 可能在上一次运行里创建、
 * 在这次运行里被 `step.metadata` 或 `tool.output-denied` 更新，它的归属仍是
 * 创建它的那次运行。
 */
async function upsertStepRows(
  tx: Transaction,
  steps: StepInsertModel[]
): Promise<void> {
  for (const step of steps) {
    await tx
      .insert(step_table)
      .values(step)
      .onConflictDoUpdate({
        target: step_table.id,
        set: {
          turnId: step.turnId,
          sessionId: step.sessionId,
          seq: step.seq,
          type: step.type,
          status: step.status,
          content: step.content,
          updatedAt: step.updatedAt,
        },
      });
  }
}

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

  async getBranchTurns(
    sessionId: string,
    options?: { activeStreamId?: string }
  ): Promise<TurnRecord[]> {
    const session = await this.getSessionById(sessionId);
    if (!session?.activeHeadId) {
      return [];
    }

    const turns = await db
      .select()
      .from(turn_table)
      .where(eq(turn_table.sessionId, sessionId))
      .orderBy(asc(turn_table.createdAt), asc(turn_table.id));
    const turnsMap = new Map(turns.map((turn) => [turn.id, turn]));

    const branch: TurnModel[] = [];
    let current = turnsMap.get(session.activeHeadId);
    while (current) {
      branch.unshift(current);
      turnsMap.delete(current.id);
      current = current.parentId ? turnsMap.get(current.parentId) : undefined;
    }
    if (branch.length === 0) {
      return [];
    }

    // 一次取这个会话的全部 step：branch 通常很短，多取几个非 branch 的行比
    // 按 turn id 拼 in 查询更简单，也不会撞上 SQLite 的参数个数上限。
    const steps = await db
      .select()
      .from(step_table)
      .where(eq(step_table.sessionId, sessionId))
      .orderBy(asc(step_table.turnId), asc(step_table.seq));
    const stepsByTurn = new Map<string, StepModel[]>();
    for (const step of steps) {
      const list = stepsByTurn.get(step.turnId);
      if (list) {
        list.push(step);
      } else {
        stepsByTurn.set(step.turnId, [step]);
      }
    }

    return branch.map((turn) =>
      hydrateTurn(turn, stepsByTurn.get(turn.id) ?? [], options?.activeStreamId)
    );
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

  async saveTurn(turn: TurnWrite): Promise<number> {
    // Upsert: client resends existing message ids on regenerate. 只改可变行字段，
    // parentId 和 createdAt 保持它原来的 branch 位置。
    const row = toTurnRow(turn);
    const steps = toStepRows({
      turnId: turn.id,
      sessionId: turn.sessionId,
      content: turn.content,
    });

    await db.transaction(async (tx) => {
      await tx
        .insert(turn_table)
        .values(row)
        .onConflictDoUpdate({
          target: turn_table.id,
          set: {
            type: row.type,
            metadata: row.metadata,
            status: row.status,
            detail: row.detail,
            completedAt: row.completedAt,
            updatedAt: row.updatedAt,
          },
        });
      await upsertStepRows(tx, steps);
    });

    return 1;
  }

  async saveTurns(turns: TurnWrite[]): Promise<number> {
    await db.transaction(async (tx) => {
      for (const turn of turns) {
        await tx.insert(turn_table).values(toTurnRow(turn));
        await upsertStepRows(
          tx,
          toStepRows({
            turnId: turn.id,
            sessionId: turn.sessionId,
            content: turn.content,
          })
        );
      }
    });

    return turns.length;
  }

  async insertTurnInBranch({ turn }: { turn: TurnWrite }): Promise<void> {
    // Insert the turn and make it the branch head in one transaction, so a
    // failure cannot leave a dangling row or an active head pointing at
    // nothing. Turns are only appended: a manual compaction records its cut
    // point instead of splicing itself into the middle of the branch.
    await db.transaction(async (tx) => {
      await tx.insert(turn_table).values(toTurnRow(turn));
      await upsertStepRows(
        tx,
        toStepRows({
          turnId: turn.id,
          sessionId: turn.sessionId,
          content: turn.content,
        })
      );

      if (turn.sessionId) {
        await tx
          .update(session_table)
          .set({ activeHeadId: turn.id })
          .where(eq(session_table.id, turn.sessionId));
      }
    });
  }

  async saveStep(step: StepInsertModel): Promise<number> {
    // upsert 不覆盖 stream_id：step 的归属永远是创建它的那次运行，后来的
    // step.metadata / tool.output-denied 只改内容。
    const result = await db
      .insert(step_table)
      .values(step)
      .onConflictDoUpdate({
        target: step_table.id,
        set: {
          turnId: step.turnId,
          sessionId: step.sessionId,
          seq: step.seq,
          type: step.type,
          status: step.status,
          content: step.content,
          updatedAt: step.updatedAt,
        },
      });
    return result.rowsAffected;
  }

  async beginTurn({ turn }: { turn: TurnWrite }): Promise<void> {
    // 强制成 streaming：恢复一条 wait_review turn 时，内存里的 status 可能还是
    // 旧值；这一行是崩溃标记，必须从回合开始就写明正在运行。
    const row = {
      ...toTurnRow(turn),
      status: "streaming" as const,
      completedAt: null,
    };

    await db.transaction(async (tx) => {
      await tx
        .insert(turn_table)
        .values(row)
        .onConflictDoUpdate({
          target: turn_table.id,
          set: {
            type: row.type,
            status: row.status,
            detail: row.detail,
            completedAt: row.completedAt,
            updatedAt: row.updatedAt,
          },
        });

      if (turn.sessionId) {
        await tx
          .update(session_table)
          .set({ activeHeadId: turn.id })
          .where(eq(session_table.id, turn.sessionId));
      }
    });
  }

  async updateTurnHeader(id: string, turn: AgentTurn): Promise<number> {
    const result = await db
      .update(turn_table)
      .set({
        status: turn.status,
        detail: turnDetailOf(turn),
        completedAt:
          turn.completedAt === undefined ? null : new Date(turn.completedAt),
        updatedAt: new Date(),
      })
      .where(eq(turn_table.id, id));
    return result.rowsAffected;
  }

  async updateTurn(id: string, turn: AgentTurn): Promise<number> {
    // 只更新已存在的 step 行。新 step 由 `step.finish` 插入；崩溃时正在执行的
    // step 没有行，也不应该在这里被补造成历史。
    return await db.transaction(async (tx) => {
      const header = await tx
        .update(turn_table)
        .set({
          status: turn.status,
          detail: turnDetailOf(turn),
          completedAt:
            turn.completedAt === undefined ? null : new Date(turn.completedAt),
          updatedAt: new Date(),
        })
        .where(eq(turn_table.id, id));

      const now = new Date();
      for (const [seq, step] of turn.content.entries()) {
        await tx
          .update(step_table)
          .set({
            seq,
            type: step.type,
            status: step.status,
            content: step,
            updatedAt: now,
          })
          .where(eq(step_table.id, step.id));
      }

      return header.rowsAffected;
    });
  }
}
