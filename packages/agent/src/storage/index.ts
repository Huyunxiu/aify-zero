import type {
  SessionInsertModel,
  SessionModel,
  TurnInsertModel,
  TurnModel,
} from "@workspace/db";

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
  getBranchTurns(
    sessionId: string,
    messages?: TurnModel[]
  ): Promise<TurnModel[]>;

  setActiveHead(
    sessionId: string,
    messageId: string | undefined
  ): Promise<number>;

  existsTurn(id: string): Promise<boolean>;

  saveTurn(message: TurnInsertModel): Promise<number>;

  saveTurns(messages: TurnInsertModel[]): Promise<number>;

  updateTurn(id: string, parts: unknown, metadata: unknown): Promise<number>;
}
