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

  getMessagesBySessionId(sessionId: string): Promise<MessageModel[]>;

  existsMessages(id: string): Promise<boolean>;

  saveMessage(message: MessageInsertModel): Promise<number>;

  saveMessages(messages: MessageInsertModel[]): Promise<number>;

  updateMessage(id: string, parts: unknown, metadata: unknown): Promise<number>;
}
