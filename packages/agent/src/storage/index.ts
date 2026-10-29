import type {
  AgentSteeringStep,
  AgentTurn,
  EnqueueInboxInput,
  InboxMessage,
  InboxPlacement,
} from "@workspace/agent-client";
import type {
  SessionInsertModel,
  SessionModel,
  SessionStatus,
  StepInsertModel,
} from "@workspace/db";

import type { TurnRecord, TurnWrite } from "./turn-record";

export type { TurnDetail, TurnRecord, TurnWrite } from "./turn-record";

export type SessionEndStatus = Exclude<SessionStatus, "running">;

export interface AgentStore {
  /**
   * 按时间列出会话。
   *
   * `kind` 是必填的，没有默认值：会话表里同时躺着用户的会话和子 agent 的
   * transcript，漏掉这个条件不会报错，只会让子 agent 悄悄混进列表——侧边栏
   * 被填满、分页游标跟着错位。做成必填，漏传就是编译错误。
   */
  listSessions({
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
    /** 按项目收窄；省略时列出所有项目的会话。 */
    projectId?: string;
  }): Promise<SessionModel[]>;

  /**
   * 找回一次 `task` 调用派生出的子会话。
   *
   * 父 turn 被 resume 时同一个调用会再执行一遍，靠这对 (父会话, 工具调用 id)
   * 认出已经跑过的那次，接着它的 transcript 往下走，而不是新建一行再从头跑。
   * 没有派生的调用返回 null。
   */
  findSessionByParentToolCall({
    parentSessionId,
    toolCallId,
  }: {
    parentSessionId: string;
    toolCallId: string;
  }): Promise<SessionModel | null>;

  /**
   * 一个会话派生出的全部子会话，按父会话 id 找。
   *
   * 用来收拾父会话停掉之后的残局。子 agent 的流注册在它自己的会话名下，父的
   * stop 扫不到；进程被杀时子会话那一行会连着 `activeStreamId` 一起留下，只有
   * 这里能把它们找回来清干净。
   */
  listChildSessions(parentSessionId: string): Promise<SessionModel[]>;

  saveSession(session: SessionInsertModel): Promise<boolean>;

  getSessionById(sessionId: string): Promise<SessionModel | null>;

  updateSessionById(sessionId: string, title: string): Promise<number>;

  /**
   * 一条 branch 的完整 turn：turn 行 + step 行拼出的 content。
   *
   * `activeStreamId` 是会话当前正在跑的那次运行。传入后，streaming turn 里
   * 属于这次运行的 step 会被隐藏：客户端会用流的重放重建它们，提前返回会
   * 造成文本和工具调用重复。上一次运行留下的 step 仍然返回。
   */
  getBranchTurns(
    sessionId: string,
    options?: { activeStreamId?: string }
  ): Promise<TurnRecord[]>;

  setActiveHead(
    sessionId: string,
    messageId: string | undefined
  ): Promise<number>;

  /**
   * Records the stream currently running for the session and moves it to
   * `running`, in one write so the two cannot disagree.
   *
   * `activeStreamId` is the stream's identity, not the session's state: the
   * in-memory stream registry is what actually holds the running turn, and this
   * is the hint a freshly loaded client reads to find it again. The session's
   * state is `status`. Together they hold one invariant —
   * `activeStreamId != null` exactly when the status is a live one — which is
   * why neither is ever written without the other.
   */
  setActiveStream(sessionId: string, streamId: string): Promise<number>;

  /**
   * Clears the marker only while it still names this `streamId`, and settles
   * the session into `status` in the same write. A stream that was replaced by
   * a newer one must not wipe the newer one's marker when its own pump
   * finishes.
   */
  clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus
  ): Promise<number>;

  /**
   * Retires the unread mark a finished turn left behind, by moving a session
   * out of `done` and back to `idle`.
   *
   * Scoped to `done` so it cannot walk over a live one: a session that is
   * `running`, or already settled into `canceled`/`error`, is left alone. It
   * also leaves `activeStreamId` untouched — the stream's marker is not this
   * call's business.
   *
   * @returns rows changed, so a caller can tell a real read from a no-op.
   */
  markSessionRead(sessionId: string): Promise<number>;

  /**
   * 写一条完整 turn：turn 行 + 它的全部 step。
   *
   * 用于新的 user turn，也用于兜底写入一条还没落库的 turn。upsert 时只更新
   * 可变的行字段，保留原有 parentId 和 createdAt。
   *
   * 带 `inboxId` 时，删除 Inbox 行和写入 turn 在同一个事务里完成：删除 0 行
   * 说明这条消息已被另一个调用者领走，抛 `InboxMessageNotFoundError`。
   */
  saveTurn(turn: TurnWrite, options?: { inboxId?: string }): Promise<number>;

  /** fork 专用：批量写入 turn 行和 step 行。 */
  saveTurns(turns: TurnWrite[]): Promise<number>;

  /**
   * 写一个已经到达 `step.finish` 的 step。
   *
   * 冲突时只更新可变列，不覆盖 `stream_id`：一个 step 可能在上一次运行里创建、
   * 在这次运行里被 `step.metadata` 或 `tool.output-denied` 更新，它的归属仍是
   * 创建它的那次运行。
   */
  saveStep(step: StepInsertModel): Promise<number>;

  /**
   * 按 seq 列出会话的待发送消息，可只取某一种 placement。
   *
   * 领取成功时行会被删除，所以这里只返回仍然待发送的内容。
   */
  listInboxMessages(
    sessionId: string,
    options?: { placement?: InboxPlacement }
  ): Promise<InboxMessage[]>;

  /**
   * 幂等入队一条消息。
   *
   * `(sessionId, requestId)` 冲突时返回已有行，客户端重试不会产生两条。
   */
  insertInboxMessage(input: EnqueueInboxInput): Promise<InboxMessage>;

  /** 删除一条待发送消息；返回删除的行数。 */
  deleteInboxMessage(sessionId: string, id: string): Promise<number>;

  /** 清空会话的待发送消息；返回删除的行数。 */
  clearInboxMessages(sessionId: string): Promise<number>;

  /**
   * 原子领取 next-step 消息，并把它们写进指定 assistant turn 的 step 表。
   *
   * 删除 Inbox 行和插入 steering step 在同一个事务里完成；只插入仍在表中的
   * id，因此被取消或被并发领走的行不会变成 step。step id 就是 Inbox 行 id，
   * 前端据此把队列项和 transcript 里的 step 对上。
   */
  applySteeringSteps(input: {
    sessionId: string;
    turnId: string;
    streamId: string;
    messageIds: string[];
  }): Promise<AgentSteeringStep[]>;

  /** 把会话里残留的 next-step 消息提升为 next-turn；返回提升的行数。 */
  promoteStaleInboxMessages(sessionId: string): Promise<number>;

  /**
   * 追加一条 turn 并把它设为 branch 的新 head。
   *
   * 与 `saveTurn` 的区别：这里只管插入和拓扑，不做 upsert；插入和
   * `activeHeadId` 的更新在同一个事务里完成，失败不会在 branch 上留下孤儿。
   *
   * 它只追加，不插入中间：手工压缩的切点记录在 `CompactionRecord` 里，branch
   * 始终保持线性，客户端本地的 turn 列表因此永远是 branch 的前缀。
   */
  insertTurnInBranch({ turn }: { turn: TurnWrite }): Promise<void>;

  /**
   * 回合开始时先把 turn 行写成 `streaming`，并把它设为 branch head。
   *
   * 这一步不写 step：新回合还没有 step，审批恢复的 step 已经在表里。它的价值
   * 是留一个可靠的崩溃标记——进程在回合中途退出时，这一行仍然是
   * `streaming`，启动恢复据此知道该收尾哪条 turn。
   *
   * upsert 只改 status/detail/completedAt 和 type；parentId 与 createdAt
   * 保持原值，审批恢复因此复用同一个 turn 节点。
   */
  beginTurn({ turn }: { turn: TurnWrite }): Promise<void>;

  /**
   * 只更新 turn 行的 status/detail/completedAt，不碰 step。
   *
   * `turn.finish` 之后、收尾循环之前调用：即使进程在两者之间退出，turn 的
   * 终态也已经落库，不会让一条已经跑完的 turn 被恢复成 `error`。
   */
  updateTurnHeader(id: string, turn: AgentTurn): Promise<number>;

  /**
   * 用内存里的完整 turn 更新已有 turn。
   *
   * 更新 status/detail/completedAt 等行字段，并同步它的 step 行。step 的
   * `seq` 来自它在 content 里的下标；turn 内的 step 只追加，所以下标稳定。
   *
   * `stepIds` 限定要回写的 step：已经由 journal 写过的 step 不必再重写一遍，
   * 回合结束通常只需要补写审批恢复时改动的那一条。省略时回写全部 step。
   *
   * @returns 更新到的 turn 行数；0 表示这条 turn 还没有行。
   */
  updateTurn(
    id: string,
    turn: AgentTurn,
    options?: { stepIds?: ReadonlySet<string> }
  ): Promise<number>;
}
