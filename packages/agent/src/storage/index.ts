import type {
  SessionInsertModel,
  SessionModel,
  MessageInsertModel,
  MessageModel,
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
  getAllMessagesBySessionId(sessionId: string): Promise<MessageModel[]>;

  /**
   * Messages on the branch, walking parent_id from session.activeHeadId.
   * @param sessionId
   * @param messages
   */
  getBranchMessages(
    sessionId: string,
    messages?: MessageModel[]
  ): Promise<MessageModel[]>;

  setActiveHead(sessionId: string, messageId: string): Promise<number>;

  existsMessages(id: string): Promise<boolean>;

  saveMessage(message: MessageInsertModel): Promise<number>;

  saveMessages(messages: MessageInsertModel[]): Promise<number>;

  updateMessage(id: string, parts: unknown, metadata: unknown): Promise<number>;
}
