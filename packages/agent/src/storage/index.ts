import type {
  ThreadInsertModel,
  ThreadModel,
  MessageInsertModel,
  MessageModel,
} from "@workspace/db";

export interface AgentStore {
  listThreads({
    cursor,
    limit,
    direction,
  }: {
    cursor?: string;
    limit?: number;
    direction?: "asc" | "desc";
  }): Promise<ThreadModel[]>;

  saveThread(thread: ThreadInsertModel): Promise<boolean>;

  updateThread(threadId: string, title: string): Promise<number>;

  getThreadById(threadId: string): Promise<ThreadModel | null>;

  updateThreadById(threadId: string, title: string): Promise<number>;

  getMessagesByThreadId(threadId: string): Promise<MessageModel[]>;

  existsMessages(id: string): Promise<boolean>;

  saveMessage(message: MessageInsertModel): Promise<number>;

  saveMessages(messages: MessageInsertModel[]): Promise<number>;

  updateMessage(id: string, parts: unknown, metadata: unknown): Promise<number>;
}
