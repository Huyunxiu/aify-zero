import type {
  AgentSteeringStep,
  AgentTurn,
  DeliverAt,
  EnqueueInboxInput,
  InboxItem,
} from "@workspace/agent-client";

import type {
  SessionEndStatus,
  SessionKind,
  SessionRecord,
  SessionWrite,
  StepWrite,
  StreamActivityOption,
  TurnRecord,
  TurnWrite,
} from "./types";

export type {
  SessionEndStatus,
  SessionKind,
  SessionRecord,
  SessionStatus,
  SessionWrite,
  StepRow,
  StepWrite,
  StreamActivityOption,
  TurnRecord,
  TurnRow,
  TurnStatus,
  TurnTableRow,
  TurnWrite,
} from "./types";
export type { TurnDetail } from "./turn-record";

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
    kind: SessionKind;
    /** 按项目收窄；省略时列出所有项目的会话。 */
    projectId?: string;
  }): Promise<SessionRecord[]>;

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
  }): Promise<SessionRecord | null>;

  /**
   * 一个会话派生出的全部子会话，按父会话 id 找。
   *
   * 用来收拾父会话停掉之后的残局。子 agent 的流注册在它自己的会话名下，父的
   * stop 扫不到；进程被杀时子会话那一行会连着 `activeStreamId` 一起留下，只有
   * 这里能把它们找回来清干净。
   */
  listChildSessions(parentSessionId: string): Promise<SessionRecord[]>;

  saveSession(session: SessionWrite): Promise<boolean>;

  getSessionById(sessionId: string): Promise<SessionRecord | null>;

  updateSessionById(sessionId: string, title: string): Promise<number>;

  /**
   * 读会话行，不过滤删除。
   *
   * 只给两条路径用：建会话（删掉的行不能被当成「已存在」悄悄放行）和删除本身
   * （判断是不是已经删过）。其余读路径一律走 `getSessionById`。
   */
  findSessionRow(sessionId: string): Promise<SessionRecord | null>;

  /**
   * 软删除一个会话：写上 `deletedAt`，并清掉它名下还没发生的事。
   *
   * 按 `parentSessionId` 递归派生子会话，一起处理；全部在一个事务里，要么全成
   * 要么全不成。`removed: false` 表示这一行已经被删过——两个窗口同时删，只有
   * 一边为真。
   */
  deleteSession(
    sessionId: string,
    deletedAt: Date
  ): Promise<{ removed: boolean; sessionIds: string[] }>;

  /**
   * 一个会话派生出的全部会话 id，含它自己。
   *
   * 删除要在事务之外先停任务：任务还在写的时候删行，删完又会冒出新的。事务里
   * 会再走一遍同样的子树，以事务里的结果为准。
   */
  listSessionSubtreeIds(sessionId: string): Promise<string[]>;

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
  setActiveStream(
    sessionId: string,
    streamId: string,
    options: StreamActivityOption
  ): Promise<number>;

  /**
   * Clears the marker only while it still names this `streamId`, and settles
   * the session into `status` in the same write. A stream that was replaced by
   * a newer one must not wipe the newer one's marker when its own pump
   * finishes.
   */
  clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus,
    options: StreamActivityOption
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
   * 用于兜底写入一条还没落库的 turn。upsert 时只更新可变的行字段，保留原有
   * parentId 和 createdAt。
   *
   * 带 `head` 时，同一事务里把这条 turn 设为 branch 的新 head。turn 只追加，
   * 压缩记录切点而不把自己插进 branch 中间，所以 head 永远指向末尾的那条。
   */
  saveTurn(turn: TurnWrite, options?: { head?: boolean }): Promise<number>;

  /** fork 专用：批量写入 turn 行和 step 行。 */
  saveTurns(turns: TurnWrite[]): Promise<number>;

  /**
   * 把一批由收件箱领取的 turn 追加进 branch。
   *
   * 删除收件箱行、写 turn、串父链和设 head 在同一个事务里完成。领取以删除的
   * 结果为准：被取消或并发领走的行退出这一批，其余照常写。一条都没领到时抛
   * `InboxItemNotFoundError`，调用方据此知道整批已被别人领走。
   *
   * 父链由这里按领取顺序重算，忽略 `claims[].turn.parentId`：批次里的某一条
   * 被取消时，调用方预先算好的链会指向没写进去的 turn，branch 会从此断掉。
   *
   * @returns 实际写入的 turn id，顺序就是它们在 branch 里的顺序。
   */
  saveClaimedTurns(input: {
    sessionId: string;
    /** 这一批追加到哪条之后；省略表示接在 branch 开头。 */
    parentTurnId?: string | null;
    claims: readonly { inboxId: string; turn: TurnWrite }[];
    /** 写完后把 head 设到最后一条写入的 turn。 */
    head?: boolean;
  }): Promise<readonly string[]>;

  /**
   * 写一个已经到达 `step.finish` 的 step。
   *
   * 冲突时只更新可变列，不覆盖 `stream_id`：一个 step 可能在上一次运行里创建、
   * 在这次运行里被 `step.metadata` 或 `tool.output-denied` 更新，它的归属仍是
   * 创建它的那次运行。
   */
  saveStep(step: StepWrite): Promise<number>;

  /**
   * 按 seq 列出会话的待办项，可只取某一种交付边界。
   *
   * 领取成功时行会被删除，所以这里只返回仍然待领取的内容。
   */
  listInboxItems(
    sessionId: string,
    options?: { deliverAt?: DeliverAt }
  ): Promise<InboxItem[]>;

  /**
   * 幂等入队一条待办项。
   *
   * `(sessionId, dedupeKey)` 冲突时返回已有行，客户端重试不会产生两条。
   */
  insertInboxItem(input: EnqueueInboxInput): Promise<InboxItem>;

  /**
   * 列出收件箱里还有待办项的会话。
   *
   * 启动扫描用它：进程退出时队列没跑完的会话，重启后要各唤醒一次。
   */
  listPendingInboxSessionIds(): Promise<string[]>;

  /** 删除会话的待办项；`ids` 省略时清空。返回删除的行数。 */
  deleteInboxItems(sessionId: string, ids?: readonly string[]): Promise<number>;

  /**
   * 原子领取 step-boundary 的待办项，并把它们写进指定 assistant turn 的 step 表。
   *
   * 删除收件箱行和插入 steering step 在同一个事务里完成；只插入仍在表中的
   * id，因此被取消或被并发领走的行不会变成 step。step id 就是收件箱行 id，
   * 前端据此把排队项和 transcript 里的 step 对上。
   */
  applySteeringSteps(input: {
    sessionId: string;
    turnId: string;
    streamId: string;
    messageIds: string[];
  }): Promise<AgentSteeringStep[]>;

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
   * 更新 turn 行，并按 `stepIds` 指名回写 step 行。
   *
   * `stepIds` 省略时只写 status/detail/completedAt：`turn.finish` 之后、收尾循环
   * 之前先落终态，进程在两者之间退出了也不会让一条已经跑完的 turn 被恢复成
   * `error`。
   *
   * 传集合时只回写集合里的 step。step 的 `seq` 来自它在 content 里的下标；
   * turn 内的 step 只追加，所以下标稳定。已经由 journal 写过的 step 不必再写
   * 一遍，回合结束通常只需要补写审批恢复时改动的那一条。
   *
   * `sessionId` 是必填的：业务 id 只在会话内唯一，fork 之后两个会话会有相同
   * 的 turn id。少了它，一次写入会同时命中两份副本。
   *
   * @returns 更新到的 turn 行数；0 表示这条 turn 还没有行。
   */
  updateTurn(
    sessionId: string,
    id: string,
    turn: AgentTurn,
    options?: { stepIds?: ReadonlySet<string> }
  ): Promise<number>;
}
