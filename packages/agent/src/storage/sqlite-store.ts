import type {
  AgentSteeringStep,
  AgentTurn,
  AgentUserTurn,
  EnqueueInboxInput,
  InboxMessage,
  InboxPlacement,
  InboxPayload,
} from "@workspace/agent-client";
import {
  inbox_message_table,
  session_table,
  db,
  step_table,
  turn_table,
} from "@workspace/db";
import type {
  InboxMessageModel,
  SessionInsertModel,
  SessionModel,
  StepInsertModel,
  StepModel,
  TurnModel,
} from "@workspace/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  max,
} from "drizzle-orm";

import type { AgentStore, SessionEndStatus } from ".";
import { InboxMessageNotFoundError } from "../inbox/errors";
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

/**
 * 把 Inbox 行映射成 wire 类型。
 *
 * `content` / `payload` 在 schema 里是 `unknown` 的 JSON 列；写入时来自
 * `EnqueueInboxInput`，读取时在这里收窄回会话类型。
 */
function toInboxMessage(row: InboxMessageModel): InboxMessage {
  return {
    seq: row.seq,
    id: row.id,
    sessionId: row.sessionId,
    requestId: row.requestId,
    placement: row.placement,
    content: row.content as AgentUserTurn,
    payload: row.payload as InboxPayload,
    createdAt: row.createdAt.getTime(),
  };
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

  /** 启动恢复用：所有还挂着流标记的会话（含子 agent）。 */
  async listInterruptedSessions(): Promise<SessionModel[]> {
    return await db
      .select()
      .from(session_table)
      .where(isNotNull(session_table.activeStreamId));
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

  async saveTurn(
    turn: TurnWrite,
    options?: { inboxId?: string }
  ): Promise<number> {
    // Upsert: client resends existing message ids on regenerate. 只改可变行字段，
    // parentId 和 createdAt 保持它原来的 branch 位置。
    const row = toTurnRow(turn);
    const steps = toStepRows({
      turnId: turn.id,
      sessionId: turn.sessionId,
      content: turn.content,
    });

    await db.transaction(async (tx) => {
      // 认领和写入必须同成同败：删不到行说明消息已经被另一个调用者领走，
      // 这时不能再写一条重复的 user turn。
      if (options?.inboxId) {
        const claimed = await tx
          .delete(inbox_message_table)
          .where(
            and(
              eq(inbox_message_table.id, options.inboxId),
              eq(inbox_message_table.sessionId, turn.sessionId)
            )
          )
          .returning({ id: inbox_message_table.id });

        if (claimed.length === 0) {
          throw new InboxMessageNotFoundError(options.inboxId);
        }
      }

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

  async listInboxMessages(
    sessionId: string,
    options?: { placement?: InboxPlacement }
  ): Promise<InboxMessage[]> {
    const conditions = [eq(inbox_message_table.sessionId, sessionId)];

    if (options?.placement) {
      conditions.push(eq(inbox_message_table.placement, options.placement));
    }

    const rows = await db
      .select()
      .from(inbox_message_table)
      .where(and(...conditions))
      .orderBy(asc(inbox_message_table.seq));

    return rows.map(toInboxMessage);
  }

  async insertInboxMessage(input: EnqueueInboxInput): Promise<InboxMessage> {
    // 冲突时不报错，随后按幂等键把已有行读回来：客户端重试和并发提交都
    // 只会留下一条。
    await db
      .insert(inbox_message_table)
      .values({
        sessionId: input.sessionId,
        requestId: input.requestId,
        placement: input.placement,
        content: input.content,
        payload: input.payload,
      })
      .onConflictDoNothing();

    const [row] = await db
      .select()
      .from(inbox_message_table)
      .where(
        and(
          eq(inbox_message_table.sessionId, input.sessionId),
          eq(inbox_message_table.requestId, input.requestId)
        )
      )
      .limit(1);

    if (!row) {
      throw new Error("inbox message insert did not produce a row");
    }

    return toInboxMessage(row);
  }

  async deleteInboxMessage(sessionId: string, id: string): Promise<number> {
    const removed = await db
      .delete(inbox_message_table)
      .where(
        and(
          eq(inbox_message_table.sessionId, sessionId),
          eq(inbox_message_table.id, id)
        )
      )
      .returning({ id: inbox_message_table.id });

    return removed.length;
  }

  async clearInboxMessages(sessionId: string): Promise<number> {
    const removed = await db
      .delete(inbox_message_table)
      .where(eq(inbox_message_table.sessionId, sessionId))
      .returning({ id: inbox_message_table.id });

    return removed.length;
  }

  async applySteeringSteps({
    sessionId,
    turnId,
    streamId,
    messageIds,
  }: {
    sessionId: string;
    turnId: string;
    streamId: string;
    messageIds: string[];
  }): Promise<AgentSteeringStep[]> {
    if (messageIds.length === 0) {
      return [];
    }

    return await db.transaction(async (tx) => {
      // 先删再插：只有仍然存在的行会进入 RETURNING，取消或并发领走的消息
      // 不会变成 step。
      const claimed = await tx
        .delete(inbox_message_table)
        .where(
          and(
            eq(inbox_message_table.sessionId, sessionId),
            inArray(inbox_message_table.id, messageIds)
          )
        )
        .returning();

      if (claimed.length === 0) {
        return [];
      }

      const ordered = claimed.toSorted((left, right) => left.seq - right.seq);
      const [head] = await tx
        .select({ lastSeq: max(step_table.seq) })
        .from(step_table)
        .where(eq(step_table.turnId, turnId));
      let seq = (head?.lastSeq ?? -1) + 1;

      const steps: AgentSteeringStep[] = [];

      for (const row of ordered) {
        const turn = row.content as AgentUserTurn;
        const createdAt = row.createdAt.getTime();
        const step: AgentSteeringStep = {
          id: row.id,
          type: "steering",
          createdAt,
          completedAt: createdAt,
          status: "done",
          content: turn.content.flatMap((userStep) => userStep.content),
        };

        await tx.insert(step_table).values({
          id: step.id,
          turnId,
          sessionId,
          seq,
          streamId,
          type: step.type,
          status: step.status,
          content: step,
          createdAt: new Date(createdAt),
          updatedAt: new Date(),
        });

        steps.push(step);
        seq += 1;
      }

      return steps;
    });
  }

  async promoteStaleInboxMessages(sessionId: string): Promise<number> {
    const promoted = await db
      .update(inbox_message_table)
      .set({ placement: "next-turn" })
      .where(
        and(
          eq(inbox_message_table.sessionId, sessionId),
          eq(inbox_message_table.placement, "next-step")
        )
      )
      .returning({ id: inbox_message_table.id });

    return promoted.length;
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
