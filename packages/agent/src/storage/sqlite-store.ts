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
 * step 行在冲突时可变的列。
 *
 * 不含 `stream_id`：一个 step 可能在上一次运行里创建、在这次运行里被
 * `step.metadata` 或 `tool.output-denied` 更新，它的归属仍是创建它的那次运行。
 */
function stepRowPatch(step: StepInsertModel) {
  return {
    turnId: step.turnId,
    sessionId: step.sessionId,
    seq: step.seq,
    type: step.type,
    status: step.status,
    content: step.content,
    updatedAt: step.updatedAt,
  };
}

/** 按 id upsert 一组 step 行。 */
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
        set: stepRowPatch(step),
      });
  }
}

/** 把 turn 设为会话的 branch head；调用方负责事务。 */
async function setHeadIn(
  tx: Transaction,
  sessionId: string,
  turnId: string
): Promise<void> {
  await tx
    .update(session_table)
    .set({ activeHeadId: turnId })
    .where(eq(session_table.id, sessionId));
}

/** turn 行里由内存 turn 推导的可变列。 */
function turnRowPatch(turn: AgentTurn) {
  return {
    status: turn.status,
    detail: turnDetailOf(turn),
    completedAt:
      turn.completedAt === undefined ? null : new Date(turn.completedAt),
    updatedAt: new Date(),
  };
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

/** 能执行 delete 的句柄：`db` 和事务句柄都满足它。 */
type Deleter = Pick<Transaction, "delete">;

/**
 * 删除会话里的 Inbox 行；`ids` 省略时删除全部。
 *
 * 返回被删的行。认领路径（`saveTurn` / `applySteeringSteps`）靠返回的行判断
 * 消息是否仍待发送：取消或并发领走的行不在其中。
 */
async function deleteInboxRows(
  handle: Deleter,
  sessionId: string,
  ids?: readonly string[]
): Promise<InboxMessageModel[]> {
  // 空集合不能退化成“删除全部”。
  if (ids?.length === 0) {
    return [];
  }

  const conditions = [eq(inbox_message_table.sessionId, sessionId)];
  if (ids) {
    conditions.push(inArray(inbox_message_table.id, [...ids]));
  }

  return await handle
    .delete(inbox_message_table)
    .where(and(...conditions))
    .returning();
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

  async saveTurn(
    turn: TurnWrite,
    options?: { inboxId?: string; head?: boolean }
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
        const claimed = await deleteInboxRows(tx, turn.sessionId, [
          options.inboxId,
        ]);

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

      // head 和写入同成同败：失败不会留下悬空的行，也不会留下指向空处的 head。
      if (options?.head) {
        await setHeadIn(tx, turn.sessionId, turn.id);
      }
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

  async saveStep(step: StepInsertModel): Promise<number> {
    // upsert 不覆盖 stream_id：step 的归属永远是创建它的那次运行，后来的
    // step.metadata / tool.output-denied 只改内容。
    const result = await db
      .insert(step_table)
      .values(step)
      .onConflictDoUpdate({
        target: step_table.id,
        set: stepRowPatch(step),
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
    // 冲突时把原值写回同一行再 RETURNING：一次往返就能拿到已有行，客户端
    // 重试和并发提交都只会留下一条。
    const [row] = await db
      .insert(inbox_message_table)
      .values({
        sessionId: input.sessionId,
        requestId: input.requestId,
        placement: input.placement,
        content: input.content,
        payload: input.payload,
      })
      .onConflictDoUpdate({
        target: [inbox_message_table.sessionId, inbox_message_table.requestId],
        set: { requestId: input.requestId },
      })
      .returning();

    if (!row) {
      throw new Error("inbox message insert did not produce a row");
    }

    return toInboxMessage(row);
  }

  /** 删除会话的待发送消息；`ids` 省略时清空。返回删除的行数。 */
  async deleteInboxMessages(
    sessionId: string,
    ids?: readonly string[]
  ): Promise<number> {
    const removed = await deleteInboxRows(db, sessionId, ids);
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
    return await db.transaction(async (tx) => {
      // 先删再插：只有仍然存在的行会进入 RETURNING，取消或并发领走的消息
      // 不会变成 step。
      const claimed = await deleteInboxRows(tx, sessionId, messageIds);

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
        await setHeadIn(tx, turn.sessionId, turn.id);
      }
    });
  }

  /**
   * 更新 turn 行，并按 `stepIds` 指名回写 step 行。
   *
   * `stepIds` 省略时只写行字段。终态在 `turn.finish` 之后、收尾循环之前先单独
   * 落一行：即使进程在两者之间退出，turn 的终态也已经落库，不会让一条已经跑
   * 完的 turn 被恢复成 `error`。
   *
   * 传集合时只更新集合里已经存在的 step 行。新 step 由 `step.finish` 插入；
   * 崩溃时正在执行的 step 没有行，也不应该在这里被补造成历史。已经由 journal
   * 写过的 step 不必再写一次，回合结束通常只需要补写审批恢复时改动的那一条。
   *
   * @returns 更新到的 turn 行数；0 表示这条 turn 还没有行。
   */
  async updateTurn(
    id: string,
    turn: AgentTurn,
    { stepIds }: { stepIds?: ReadonlySet<string> } = {}
  ): Promise<number> {
    const row = turnRowPatch(turn);

    if (!stepIds) {
      const header = await db
        .update(turn_table)
        .set(row)
        .where(eq(turn_table.id, id));
      return header.rowsAffected;
    }

    return await db.transaction(async (tx) => {
      const header = await tx
        .update(turn_table)
        .set(row)
        .where(eq(turn_table.id, id));

      const now = new Date();
      for (const [seq, step] of turn.content.entries()) {
        if (!stepIds.has(step.id)) {
          continue;
        }

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
