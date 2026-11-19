import type {
  AgentSteeringStep,
  AgentTurn,
  AgentUserTurn,
  EnqueueInboxInput,
  DeliverAt,
  InboxItem,
  InboxPayload,
  StepSource,
} from "@workspace/agent-client";
import { isSystemStepSource, TIMER_INBOX_KIND } from "@workspace/agent-client";
import {
  composeTimerTurn,
  hydrateTurn,
  InboxItemNotFoundError,
  nextOccurrence,
  TIMER_LIMIT_PER_SESSION,
  TimerError,
  toStepRows,
  toTurnRow,
  turnDetailOf,
} from "@workspace/agent/store";
import type {
  AgentStore,
  FiredTimer,
  RecurrenceRule,
  SessionEndStatus,
  StepRow,
  StepWrite,
  StreamActivityOption,
  Timer,
  TimerCounts,
  TimerInsert,
  OutboxRecordInput,
  OutboxRecorder,
  TimerStore,
  TurnRecord,
  TurnWrite,
} from "@workspace/agent/store";
import {
  inbox_item_table,
  outbox_item_table,
  session_table,
  db,
  step_table,
  timer_table,
  turn_table,
} from "@workspace/db";
import type {
  InboxItemModel,
  SessionInsertModel,
  SessionModel,
  StepModel,
  TimerModel,
  TurnModel,
} from "@workspace/db";
import { logger } from "@workspace/shared/logger";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  or,
} from "drizzle-orm";

import type { OutboxCandidate } from "../outbox/types";
import { parseSessionCursor } from "./session-cursor";

/** 会话列表一页的默认条数。翻页的路由和 store 用同一个数。 */
export const DEFAULT_SESSION_PAGE_SIZE = 20;

/** drizzle 事务回调拿到的句柄；批量写 step 的辅助函数需要它。 */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * step 行在冲突时可变的列。
 *
 * 不含 `step_id` / `session_id` / `turn_id`：业务身份和所属 turn 在创建时就固定。
 * 也不含 `stream_id`：一个 step 可能在上一次运行里创建、在这次运行里被
 * `step.metadata` 或 `tool.output-denied` 更新，它的归属仍是创建它的那次运行。
 */
function stepRowPatch(step: StepWrite) {
  return {
    seq: step.seq,
    type: step.type,
    status: step.status,
    content: step.content,
    updatedAt: step.updatedAt,
  };
}

/** 按会话内业务 id upsert 一组 step 行。 */
async function upsertStepRows(
  tx: Transaction,
  steps: StepWrite[]
): Promise<void> {
  for (const step of steps) {
    await tx
      .insert(step_table)
      .values(step)
      .onConflictDoUpdate({
        target: [step_table.sessionId, step_table.stepId],
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
 * 把收件箱行映射成 wire 类型。
 *
 * `content` / `payload` 在 schema 里是 `unknown` 的 JSON 列；写入时来自
 * `EnqueueInboxInput`，读取时在这里收窄回会话类型。
 */
function toInboxItem(row: InboxItemModel): InboxItem {
  return {
    seq: row.seq,
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    dedupeKey: row.dedupeKey,
    deliverAt: row.deliverAt,
    content: row.content as AgentUserTurn,
    payload: row.payload as InboxPayload,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * 一条待办项内容里带的系统来源。
 *
 * 收件箱行本身已经带着完整回合，来源就在回合的 step 上；用户消息没有来源，
 * 这里返回空对象，不伪造 `"user"`。
 * @param turn - 收件箱行里的回合。
 * @returns 可以展开进 steering step 的来源字段。
 */
function systemSourceOf(turn: AgentUserTurn): { source?: StepSource } {
  const source = turn.content[0]?.source;
  return isSystemStepSource(source) ? { source } : {};
}

/**
 * 把定时器行映射成 wire 类型。
 *
 * `payload` 在 schema 里是 JSON 列；写入时来自 `InboxPayload`，读取时在这里
 * 收窄回会话类型。`dueAt` 存的是时间戳，运行时用毫秒数。
 */
function toTimer(row: TimerModel): Timer {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    note: row.note,
    dueAt: row.dueAt.getTime(),
    // 数据库层不依赖 agent 的规则类型，只存 JSON；在这里收敛回规则。
    recurrence: (row.recurrence as RecurrenceRule | null) ?? null,
    payload: row.payload as InboxPayload,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * 写一条 turn 行和它的全部 step。
 *
 * 冲突时只更新可变列：`parentId` 和 `createdAt` 保持这条 turn 原来的 branch
 * 位置。两条写入路径（单条与批量领取）共用它，免得列集各写一遍。
 */
async function upsertTurnRow(
  handle: Transaction,
  turn: TurnWrite
): Promise<void> {
  const row = toTurnRow(turn);
  await handle
    .insert(turn_table)
    .values(row)
    .onConflictDoUpdate({
      target: [turn_table.sessionId, turn_table.turnId],
      set: {
        type: row.type,
        metadata: row.metadata,
        status: row.status,
        detail: row.detail,
        completedAt: row.completedAt,
        updatedAt: row.updatedAt,
      },
    });
  await upsertStepRows(
    handle,
    toStepRows({
      turnId: turn.id,
      sessionId: turn.sessionId,
      content: turn.content,
    })
  );
}

/** 能执行 delete 的句柄：`db` 和事务句柄都满足它。 */
type Deleter = Pick<Transaction, "delete">;

/** 能执行 select 的句柄：`db` 和事务句柄都满足它。 */
type Selector = Pick<Transaction, "select">;

/**
 * 一个会话派生出的全部子会话 id，含它自己。
 *
 * 子会话不可见、只能由父找回；父删了它就是孤儿，所以跟着一起删。深度用 `seen`
 * 挡住环——正常数据里没有环，但一行坏数据不该让删除转不出来。
 */
async function collectSessionSubtree(
  handle: Selector,
  rootId: string
): Promise<string[]> {
  const ids = [rootId];
  const seen = new Set(ids);
  let frontier = [rootId];

  while (frontier.length > 0) {
    const children = await handle
      .select({ id: session_table.id })
      .from(session_table)
      .where(inArray(session_table.parentSessionId, frontier));

    frontier = children.map((child) => child.id).filter((id) => !seen.has(id));

    for (const id of frontier) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

/**
 * 删除会话里的收件箱行；`ids` 省略时删除全部。
 *
 * 返回被删的行。领取路径（`saveClaimedTurns` / `applySteeringSteps`）靠返回的
 * 行判断待办项是否还没被领走：取消或并发领走的行不在其中。
 */
async function deleteInboxRows(
  handle: Deleter,
  sessionId: string,
  ids?: readonly string[]
): Promise<InboxItemModel[]> {
  // 空集合不能退化成“删除全部”。
  if (ids?.length === 0) {
    return [];
  }

  const conditions = [eq(inbox_item_table.sessionId, sessionId)];
  if (ids) {
    conditions.push(inArray(inbox_item_table.id, [...ids]));
  }

  return await handle
    .delete(inbox_item_table)
    .where(and(...conditions))
    .returning();
}

export class SQLiteStore implements AgentStore, OutboxRecorder, TimerStore {
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
    const keyset =
      cursor === undefined ? undefined : parseSessionCursor(cursor);
    // kind 是常驻条件，游标是附加的：少了 kind，子 agent 的行会挤进分页结果，
    // 翻页时把子 agent 也一起带出来。已删会话同样常驻排除：它是「不存在」，
    // 不是列表上的一个状态。
    const conditions = [
      eq(session_table.kind, kind),
      isNull(session_table.deletedAt),
      ...(projectId ? [eq(session_table.projectId, projectId)] : []),
      ...(keyset
        ? [
            // 两列的 keyset：先比 updatedAt，相等的那一批再按 id 继续往下切。
            or(
              isDesc
                ? lt(session_table.updatedAt, keyset.updatedAt)
                : gt(session_table.updatedAt, keyset.updatedAt),
              and(
                eq(session_table.updatedAt, keyset.updatedAt),
                isDesc
                  ? lt(session_table.id, keyset.id)
                  : gt(session_table.id, keyset.id)
              )
            ),
          ]
        : []),
    ];

    const sessions = await db
      .select()
      .from(session_table)
      .where(and(...conditions))
      .orderBy(
        isDesc ? desc(session_table.updatedAt) : asc(session_table.updatedAt),
        isDesc ? desc(session_table.id) : asc(session_table.id)
      )
      .limit(limit ?? DEFAULT_SESSION_PAGE_SIZE);

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
      .where(
        and(eq(session_table.id, sessionId), isNull(session_table.deletedAt))
      )
      .limit(1);
    if (!session) {
      return null;
    }

    return session;
  }

  async findSessionRow(sessionId: string): Promise<SessionModel | null> {
    const [session] = await db
      .select()
      .from(session_table)
      .where(eq(session_table.id, sessionId))
      .limit(1);

    return session ?? null;
  }

  async listSessionSubtreeIds(sessionId: string): Promise<string[]> {
    return await collectSessionSubtree(db, sessionId);
  }

  /**
   * 软删除：写 `deletedAt`，并清掉名下还没发生的事。
   *
   * 先认领再清扫：`UPDATE … WHERE deleted_at IS NULL` 的命中决定这次调用算不算
   * 删成功，两个窗口同时删时只有一边拿到行。清扫按子树的 id 走，父会话派生出的
   * 子会话一起处理。
   */
  async deleteSession(
    sessionId: string,
    deletedAt: Date
  ): Promise<{ removed: boolean; sessionIds: string[] }> {
    return await db.transaction(async (tx) => {
      const sessionIds = await collectSessionSubtree(tx, sessionId);

      const claimed = await tx
        .update(session_table)
        .set({ deletedAt })
        .where(
          and(
            inArray(session_table.id, sessionIds),
            isNull(session_table.deletedAt)
          )
        )
        .returning({ id: session_table.id });

      if (claimed.length === 0) {
        return { removed: false, sessionIds: [] };
      }

      // 只删「将来还会发生的事」：发件项、待办项、定时器。回合与步骤留着——
      // 它们就是回收站要恢复的会话记录（ADR 0022）。
      await tx
        .delete(outbox_item_table)
        .where(inArray(outbox_item_table.sessionId, sessionIds));
      await tx
        .delete(inbox_item_table)
        .where(inArray(inbox_item_table.sessionId, sessionIds));
      await tx
        .delete(timer_table)
        .where(inArray(timer_table.sessionId, sessionIds));

      return { removed: true, sessionIds };
    });
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
      .orderBy(asc(turn_table.createdAt), asc(turn_table.turnId));
    // branch 的父指针指向业务 turn id，只在会话内唯一。
    const turnsMap = new Map(turns.map((turn) => [turn.turnId, turn]));

    const branch: TurnModel[] = [];
    let current = turnsMap.get(session.activeHeadId);
    while (current) {
      branch.unshift(current);
      turnsMap.delete(current.turnId);
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
      hydrateTurn(
        turn,
        (stepsByTurn.get(turn.turnId) ?? []) as StepRow[],
        options?.activeStreamId
      )
    );
  }

  async saveTurn(
    turn: TurnWrite,
    options?: { head?: boolean }
  ): Promise<number> {
    // Upsert: client resends existing message ids on regenerate. 只改可变行字段，
    // parentId 和 createdAt 保持它原来的 branch 位置。
    await db.transaction(async (tx) => {
      await upsertTurnRow(tx, turn);

      // head 和写入同成同败：失败不会留下悬空的行，也不会留下指向空处的 head。
      if (options?.head) {
        await setHeadIn(tx, turn.sessionId, turn.id);
      }
    });

    return 1;
  }

  async saveClaimedTurns({
    sessionId,
    parentTurnId,
    claims,
    head,
  }: {
    sessionId: string;
    parentTurnId?: string | null;
    claims: readonly { inboxId: string; turn: TurnWrite }[];
    head?: boolean;
  }): Promise<readonly string[]> {
    const [firstClaim] = claims;
    if (!firstClaim) {
      return [];
    }

    const byInboxId = new Map<string, TurnWrite>();
    for (const claim of claims) {
      if (claim.turn.sessionId !== sessionId) {
        throw new Error(
          `claim ${claim.inboxId} belongs to another session ${claim.turn.sessionId}`
        );
      }
      byInboxId.set(claim.inboxId, claim.turn);
    }

    return await db.transaction(async (tx) => {
      // 认领和写入必须同成同败：删不到任何一行说明整批已经被别人领走，这时
      // 不能写 turn。删到一部分说明其余的被取消了，按剩下的写就好。
      const claimed = await deleteInboxRows(
        tx,
        sessionId,
        claims.map((claim) => claim.inboxId)
      );

      if (claimed.length === 0) {
        throw new InboxItemNotFoundError(firstClaim.inboxId);
      }

      // 父链按真正领到的那几条重算：没领到的行不占位置，链也不会指向它。
      let parentId = parentTurnId ?? null;
      const written: string[] = [];

      for (const inboxRow of claimed.toSorted(
        (left, right) => left.seq - right.seq
      )) {
        const turn = byInboxId.get(inboxRow.id);
        if (!turn) {
          throw new Error(
            `claimed inbox row ${inboxRow.id} has no turn to write`
          );
        }

        const write: TurnWrite = { ...turn, parentId };
        await upsertTurnRow(tx, write);

        parentId = write.id;
        written.push(write.id);
      }

      const last = written.at(-1);
      if (head && last !== undefined) {
        await setHeadIn(tx, sessionId, last);
      }

      return written;
    });
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

  async setActiveStream(
    sessionId: string,
    streamId: string,
    { recordActivity }: StreamActivityOption
  ): Promise<number> {
    const result = await db
      .update(session_table)
      .set({
        activeStreamId: streamId,
        status: "running",
        ...(recordActivity ? { updatedAt: new Date() } : {}),
      })
      .where(eq(session_table.id, sessionId));
    return result.rowsAffected;
  }

  async clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus,
    { recordActivity }: StreamActivityOption
  ): Promise<number> {
    // Compare-and-clear: a stream that has already been superseded leaves the
    // newer stream's marker alone.
    const result = await db
      .update(session_table)
      .set({
        activeStreamId: null,
        status,
        ...(recordActivity ? { updatedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(session_table.id, sessionId),
          eq(session_table.activeStreamId, streamId)
        )
      );
    return result.rowsAffected;
  }

  async markSessionRead(sessionId: string): Promise<number> {
    return await db.transaction(async (tx) => {
      // 只认 `done`：已经起了新回合的会话，或落在 `canceled`/`error` 的会话，
      // 不能被一次读回退成 `idle`。
      const result = await tx
        .update(session_table)
        .set({ status: "idle" })
        .where(
          and(eq(session_table.id, sessionId), eq(session_table.status, "done"))
        );

      // 状态没变就什么都没发生：正在跑或已经出错的会话，即使页面调了这里，
      // 也不该丢掉它待投的行。
      if (result.rowsAffected === 0) {
        return 0;
      }

      // 标记已读也算看过这条会话待投的系统通知：这些行指向的回合就在会话记录里。
      // 留着它们，下一次运行把会话重新写成 `done` 时，旧行会和新行一起弹出来。
      await tx
        .update(outbox_item_table)
        .set({ expiredAt: new Date() })
        .where(
          and(
            eq(outbox_item_table.sessionId, sessionId),
            isNull(outbox_item_table.deliveredAt),
            isNull(outbox_item_table.expiredAt)
          )
        );

      return result.rowsAffected;
    });
  }

  async saveStep(step: StepWrite): Promise<number> {
    // upsert 不覆盖 stream_id：step 的归属永远是创建它的那次运行，后来的
    // step.metadata / tool.output-denied 只改内容。
    const result = await db
      .insert(step_table)
      .values(step)
      .onConflictDoUpdate({
        target: [step_table.sessionId, step_table.stepId],
        set: stepRowPatch(step),
      });
    return result.rowsAffected;
  }

  async listInboxItems(
    sessionId: string,
    options?: { deliverAt?: DeliverAt }
  ): Promise<InboxItem[]> {
    const conditions = [eq(inbox_item_table.sessionId, sessionId)];

    if (options?.deliverAt) {
      conditions.push(eq(inbox_item_table.deliverAt, options.deliverAt));
    }

    const rows = await db
      .select()
      .from(inbox_item_table)
      .where(and(...conditions))
      .orderBy(asc(inbox_item_table.seq));

    return rows.map(toInboxItem);
  }

  async insertInboxItem(input: EnqueueInboxInput): Promise<InboxItem> {
    // 冲突时把原值写回同一行再 RETURNING：一次往返就能拿到已有行，客户端
    // 重试和并发提交都只会留下一条。
    const [row] = await db
      .insert(inbox_item_table)
      .values({
        sessionId: input.sessionId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        deliverAt: input.deliverAt,
        content: input.content,
        payload: input.payload,
      })
      .onConflictDoUpdate({
        target: [inbox_item_table.sessionId, inbox_item_table.dedupeKey],
        set: { dedupeKey: input.dedupeKey },
      })
      .returning();

    if (!row) {
      throw new Error("inbox item insert did not produce a row");
    }

    return toInboxItem(row);
  }

  async listPendingInboxSessionIds(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ sessionId: inbox_item_table.sessionId })
      .from(inbox_item_table);

    return rows.map((row) => row.sessionId);
  }

  /** 删除会话的待办项；`ids` 省略时清空。返回删除的行数。 */
  async deleteInboxItems(
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
        .where(
          and(
            eq(step_table.sessionId, sessionId),
            eq(step_table.turnId, turnId)
          )
        );
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
          // 系统写进来的行仍然是系统消息，不是用户说的话。来源从行内容里取，
          // 不按 kind 再列一遍：多一种来源时这里不必改。
          ...systemSourceOf(turn),
          content: turn.content.flatMap((userStep) => userStep.content),
        };

        await tx.insert(step_table).values({
          stepId: step.id,
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
          target: [turn_table.sessionId, turn_table.turnId],
          set: {
            type: row.type,
            status: row.status,
            detail: row.detail,
            completedAt: row.completedAt,
            updatedAt: row.updatedAt,
          },
        });

      await setHeadIn(tx, turn.sessionId, turn.id);
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
    sessionId: string,
    id: string,
    turn: AgentTurn,
    { stepIds }: { stepIds?: ReadonlySet<string> } = {}
  ): Promise<number> {
    const row = turnRowPatch(turn);
    const turnWhere = and(
      eq(turn_table.sessionId, sessionId),
      eq(turn_table.turnId, id)
    );

    if (!stepIds) {
      const header = await db.update(turn_table).set(row).where(turnWhere);
      return header.rowsAffected;
    }

    return await db.transaction(async (tx) => {
      const header = await tx.update(turn_table).set(row).where(turnWhere);

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
          .where(
            and(
              eq(step_table.sessionId, sessionId),
              eq(step_table.stepId, step.id)
            )
          );
      }

      return header.rowsAffected;
    });
  }

  async insertTimer({
    sessionId,
    toolCallId,
    note,
    dueAt,
    recurrence,
    payload,
  }: TimerInsert): Promise<Timer> {
    return await db.transaction(async (tx) => {
      // 先看这个工具调用有没有排过：重试同一步时返回原来那条，不排第二个。
      const [existing] = await tx
        .select()
        .from(timer_table)
        .where(
          and(
            eq(timer_table.sessionId, sessionId),
            eq(timer_table.toolCallId, toolCallId)
          )
        );

      if (existing) {
        return toTimer(existing);
      }

      // 上限检查和插入在同一个事务里：两个并发的工具调用不能都看到「还差一个」。
      const owned = await tx
        .select({ id: timer_table.id })
        .from(timer_table)
        .where(eq(timer_table.sessionId, sessionId));

      if (owned.length >= TIMER_LIMIT_PER_SESSION) {
        throw new TimerError(
          `session ${sessionId} already has ${owned.length} pending timers; cancel one before setting another`,
          "TIMER_LIMIT_REACHED"
        );
      }

      const [row] = await tx
        .insert(timer_table)
        .values({
          sessionId,
          toolCallId,
          note,
          dueAt: new Date(dueAt),
          recurrence,
          payload,
        })
        .returning();

      if (!row) {
        throw new Error("timer insert did not produce a row");
      }

      return toTimer(row);
    });
  }

  async listTimers(sessionId: string): Promise<Timer[]> {
    const rows = await db
      .select()
      .from(timer_table)
      .where(eq(timer_table.sessionId, sessionId))
      .orderBy(asc(timer_table.dueAt));

    return rows.map(toTimer);
  }

  async cancelTimer(sessionId: string, id: string): Promise<boolean> {
    const result = await db
      .delete(timer_table)
      .where(and(eq(timer_table.sessionId, sessionId), eq(timer_table.id, id)));

    return result.rowsAffected > 0;
  }

  /**
   * 日程的下一次；算不出来就当作没有下一次。
   *
   * 规则只由写入路径产生，所以这里本该算得出来。但一条算不出来的行会每次落回
   * 同一条、每次让事务回滚，所有定时器都不再触发——这是最坏的失败。宁可丢掉这
   * 一条并留下日志，也不让整个扫描循环停摆。
   */
  #nextDueAfter(timer: Timer, now: number): number | null {
    if (timer.recurrence === null) {
      return null;
    }

    try {
      return nextOccurrence(timer.recurrence, {
        from: timer.dueAt,
        after: now,
      });
    } catch (error) {
      logger.warn("[timers] dropping a schedule that cannot advance", error);
      return null;
    }
  }

  /**
   * 取走全部到点的定时器。
   *
   * 写收件箱行和给这一行收尾在同一个事务里：待办项落地和「这一行不再挂在这里」
   * 是同一次提交，所以不存在投了两次或者丢了没投。收尾分两种——跟进用完就删，
   * 日程把 `dueAt` 推到下一次；对日程来说，这条待办项落地和「下一次已经排好」
   * 也是同一次提交。唤醒由扫描循环在提交之后做。
   */
  async fireDueTimers(now: number): Promise<FiredTimer[]> {
    return await db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(timer_table)
        .where(lte(timer_table.dueAt, new Date(now)))
        .orderBy(asc(timer_table.dueAt));

      const firedTimers: FiredTimer[] = [];

      for (const row of due) {
        const timer = toTimer(row);
        // 下一次在写正文之前算：正文要说「下一次是什么时候」。用 `now` 而不是
        // `dueAt` 往后找，停机期间错过的多次就只投这一次。
        const fired: FiredTimer = {
          ...timer,
          firedAt: now,
          nextDueAt: this.#nextDueAfter(timer, now),
        };
        // 一条日程的两次触发之间，前一条还没被领走时不该各落一行：一次运行会把
        // 它们一起领走，模型就收到 N 条说同一件事的通知。所以键只认 id，冲突时
        // 把正文换成这一次的——待办项仍然只有一条，说的仍然是最新的那一次。
        const dedupeKey = `${TIMER_INBOX_KIND}:${timer.id}`;
        const content = composeTimerTurn(fired);

        await tx
          .insert(inbox_item_table)
          .values({
            sessionId: timer.sessionId,
            kind: TIMER_INBOX_KIND,
            dedupeKey,
            // 到点不是用户插话：排在这次运行之后，不打断正在跑的回合。
            deliverAt: "run-boundary",
            content,
            payload: timer.payload,
          })
          .onConflictDoUpdate({
            target: [inbox_item_table.sessionId, inbox_item_table.dedupeKey],
            set: { dedupeKey, content },
          });

        if (fired.nextDueAt === null) {
          await tx.delete(timer_table).where(eq(timer_table.id, timer.id));
        } else {
          await tx
            .update(timer_table)
            .set({ dueAt: new Date(fired.nextDueAt) })
            .where(eq(timer_table.id, timer.id));
        }

        firedTimers.push(fired);
      }

      return firedTimers;
    });
  }

  /** 挂着的定时器数；日程是其中的子集，预算按总数算。 */
  async timerCounts(): Promise<TimerCounts> {
    const rows = await db
      .select({ id: timer_table.id, recurrence: timer_table.recurrence })
      .from(timer_table);

    return {
      pending: rows.length,
      pendingSchedules: rows.filter((row) => row.recurrence !== null).length,
    };
  }

  /**
   * 记一条发件项。
   *
   * 同一个回合重跑时不再写第二行：唯一索引挡下冲突，这里按「已经记过」处理。
   * 到达时刻显式写毫秒值：列默认的 `unixepoch() * 1000` 只到秒，竞态余量要靠
   * 它算准。
   */
  async recordOutboxItem({
    sessionId,
    turnId,
  }: OutboxRecordInput): Promise<void> {
    await db
      .insert(outbox_item_table)
      .values({ createdAt: new Date(), sessionId, turnId })
      .onConflictDoNothing();
  }

  /**
   * 取一批可以投递的发件项。
   *
   * 条件全部写在 SQL 里，投递器不需要二次判断：会话还在 `done`（有人读过就会
   * 走回 `idle`）、行没过期也没送达、到达时刻已经越过竞态余量、且不早于订阅
   * 时刻（连接建立时不补发）。
   */
  async listOutboxCandidates({
    since,
    before,
    limit,
  }: {
    since: number;
    before: number;
    limit: number;
  }): Promise<OutboxCandidate[]> {
    const rows = await db
      .select({
        id: outbox_item_table.id,
        sessionId: outbox_item_table.sessionId,
        turnId: outbox_item_table.turnId,
        title: session_table.title,
      })
      .from(outbox_item_table)
      .innerJoin(
        session_table,
        eq(session_table.id, outbox_item_table.sessionId)
      )
      .where(
        and(
          isNull(outbox_item_table.deliveredAt),
          isNull(outbox_item_table.expiredAt),
          lte(outbox_item_table.createdAt, new Date(before)),
          gte(outbox_item_table.createdAt, new Date(since)),
          eq(session_table.status, "done")
        )
      )
      .orderBy(asc(outbox_item_table.createdAt))
      .limit(limit);

    return rows;
  }

  /** 盖回执：这些发件项已经以系统通知的形式弹出来了。 */
  async markOutboxDelivered(
    ids: readonly string[],
    at: number
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const result = await db
      .update(outbox_item_table)
      .set({ deliveredAt: new Date(at) })
      .where(
        and(
          inArray(outbox_item_table.id, [...ids]),
          isNull(outbox_item_table.deliveredAt)
        )
      );

    return result.rowsAffected;
  }

  /**
   * 把等太久还没回执的行标成过期；它们不会再被取走。
   *
   * 写进 `expired_at` 的是「决定不再投」的时刻，不是「到达时刻早于它」的那条
   * 线——两者差着过期窗口，混用会让账本读起来像十分钟前就放弃了。
   */
  async expireOutboxBefore({
    deadline,
    now,
  }: {
    deadline: number;
    now: number;
  }): Promise<number> {
    const result = await db
      .update(outbox_item_table)
      .set({ expiredAt: new Date(now) })
      .where(
        and(
          isNull(outbox_item_table.deliveredAt),
          isNull(outbox_item_table.expiredAt),
          lt(outbox_item_table.createdAt, new Date(deadline))
        )
      );

    return result.rowsAffected;
  }

  /** 启动时把残留的待投行全部标过期：上一次进程没投出去的，这一次不补投。 */
  async expirePendingOutbox(at: number): Promise<number> {
    const result = await db
      .update(outbox_item_table)
      .set({ expiredAt: new Date(at) })
      .where(
        and(
          isNull(outbox_item_table.deliveredAt),
          isNull(outbox_item_table.expiredAt)
        )
      );

    return result.rowsAffected;
  }

  /** 删掉早于 `deadline` 的行：送达和过期都只留一段时间的账。 */
  async pruneOutbox(deadline: number): Promise<number> {
    const result = await db
      .delete(outbox_item_table)
      .where(lt(outbox_item_table.createdAt, new Date(deadline)));

    return result.rowsAffected;
  }

  /** 还没送达、也没过期的行数；只读状态用它回答「有没有东西在等」。 */
  async countPendingOutbox(): Promise<number> {
    const [row] = await db
      .select({ pending: count() })
      .from(outbox_item_table)
      .where(
        and(
          isNull(outbox_item_table.deliveredAt),
          isNull(outbox_item_table.expiredAt)
        )
      );

    return row?.pending ?? 0;
  }

  /** 读一个回合连同它的 step；发件项的正文从这里取。 */
  async getTurnRecord(
    sessionId: string,
    turnId: string
  ): Promise<TurnRecord | null> {
    const [row] = await db
      .select()
      .from(turn_table)
      .where(
        and(eq(turn_table.sessionId, sessionId), eq(turn_table.turnId, turnId))
      )
      .limit(1);

    if (!row) {
      return null;
    }

    const steps = await db
      .select()
      .from(step_table)
      .where(
        and(eq(step_table.sessionId, sessionId), eq(step_table.turnId, turnId))
      )
      .orderBy(asc(step_table.seq));

    return hydrateTurn(row, steps as StepRow[]);
  }
}
