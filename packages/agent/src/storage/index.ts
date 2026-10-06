import type {
  SessionInsertModel,
  SessionModel,
  SessionStatus,
  TurnInsertModel,
  TurnModel,
} from "@workspace/db";

/**
 * The states a session settles into once its stream has ended — everything
 * except the two states a live stream owns. A stopped turn is `aborted` in the
 * turn's own vocabulary; the session row says `canceled`.
 */
export type SessionEndStatus = Exclude<
  SessionStatus,
  "running" | "wait_review"
>;

export interface AgentStore {
  listSessions({
    cursor,
    limit,
    direction,
  }: {
    cursor?: string;
    limit?: number;
    direction?: "asc" | "desc";
  }): Promise<SessionModel[]>;

  saveSession(session: SessionInsertModel): Promise<boolean>;

  updateSession(sessionId: string, title: string): Promise<number>;

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

  updateTurn(id: string, parts: unknown, metadata: unknown): Promise<number>;
}
