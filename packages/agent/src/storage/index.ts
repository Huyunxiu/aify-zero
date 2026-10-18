import type {
  SessionInsertModel,
  SessionModel,
  SessionStatus,
  TurnInsertModel,
  TurnModel,
} from "@workspace/db";

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
  }: {
    cursor?: string;
    limit?: number;
    direction?: "asc" | "desc";
    kind: SessionModel["kind"];
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
   * All messages of the session, including every branch version.
   * @param sessionId
   */
  getAllTurnsBySessionId(sessionId: string): Promise<TurnModel[]>;

  /**
   * Messages on the branch, walking parent_id from session.activeHeadId.
   * @param sessionId
   * @param messages
   */
  getBranchTurns(sessionId: string, turns?: TurnModel[]): Promise<TurnModel[]>;

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

  existsTurn(id: string): Promise<boolean>;

  saveTurn(message: TurnInsertModel): Promise<number>;

  saveTurns(messages: TurnInsertModel[]): Promise<number>;

  updateTurn(id: string, parts: unknown, metadata?: unknown): Promise<number>;
}
