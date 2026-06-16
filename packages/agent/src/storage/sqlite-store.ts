import { thread_table, db, message_table } from "@workspace/db";
import type {
  ThreadInsertModel,
  ThreadModel,
  MessageInsertModel,
  MessageModel,
} from "@workspace/db";
import { and, asc, count, desc, eq, exists, gt, lt } from "drizzle-orm";

import type { AgentStore } from ".";

export class SQLiteStore implements AgentStore {
  async listThreads({
    cursor,
    limit,
    direction,
  }: {
    cursor?: string;
    limit?: number;
    direction?: "asc" | "desc";
  }): Promise<ThreadModel[]> {
    const isDesc = direction === "desc";
    const whereConditions = cursor
      ? [isDesc ? lt(thread_table.id, cursor) : gt(thread_table.id, cursor)]
      : [];

    const threads = await db
      .select()
      .from(thread_table)
      .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
      .orderBy(
        isDesc ? desc(thread_table.createdAt) : asc(thread_table.createdAt)
      )
      .limit(limit ?? 20);

    return threads;
  }

  async saveThread(thread: ThreadInsertModel): Promise<boolean> {
    const result = await db.insert(thread_table).values(thread);
    return result.rowsAffected > 0;
  }

  async updateThread(threadId: string, title: string): Promise<number> {
    const result = await db
      .update(thread_table)
      .set({ title })
      .where(eq(thread_table.id, threadId));
    return result.rowsAffected;
  }

  async getThreadById(threadId: string): Promise<ThreadModel | null> {
    const [thread] = await db
      .select()
      .from(thread_table)
      .where(eq(thread_table.id, threadId))
      .limit(1);
    if (!thread) {
      return null;
    }

    return thread;
  }

  async updateThreadById(threadId: string, title: string): Promise<number> {
    const result = await db
      .update(thread_table)
      .set({ title })
      .where(eq(thread_table.id, threadId));
    return result.rowsAffected;
  }

  async getMessagesByThreadId(threadId: string): Promise<MessageModel[]> {
    return await db
      .select()
      .from(message_table)
      .where(eq(message_table.threadId, threadId))
      .orderBy(asc(message_table.createdAt));
  }

  async existsMessages(id: string): Promise<boolean> {
    const result = await db
      .select({ count: count() })
      .from(message_table)
      .where(eq(message_table.id, id));
    return (result[0]?.count ?? 0) > 0;
  }

  async saveMessage(message: MessageInsertModel): Promise<number> {
    const result = await db.insert(message_table).values(message);
    return result.rowsAffected;
  }

  async saveMessages(messages: MessageInsertModel[]): Promise<number> {
    const result = await db.insert(message_table).values(messages);
    return result.rowsAffected;
  }

  async updateMessage(id: string, content: unknown): Promise<number> {
    const result = await db
      .update(message_table)
      .set({ content })
      .where(eq(message_table.id, id));
    return result.rowsAffected;
  }
}
