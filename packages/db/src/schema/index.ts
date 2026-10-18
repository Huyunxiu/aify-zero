import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  integer,
  index,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const agent_table = sqliteTable("agent", {
  id: text("id", { length: 36 })
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  avatar: text("avatar"),
  description: text("description"),
  instructions: text("instructions"),
  tools: text("tools", { mode: "json" }),
  models: text("models", { mode: "json" }),
  skills: text("skills", { mode: "json" }),
  config: text("config", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type AgentModel = InferSelectModel<typeof agent_table>;
export type AgentInsertModel = InferInsertModel<typeof agent_table>;

export const session_table = sqliteTable(
  "session",
  {
    id: text("id", { length: 36 })
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    title: text("title").notNull(),
    metadata: text("metadata", { mode: "json" }),
    /**
     * 这行是谁的会话。
     *
     * `subagent` 行由一次 `task` 调用派生，是子 agent 自己的 transcript 的宿主：
     * 它有完整的 turns、branch 和状态，但从不进入用户可见的会话列表。所以
     * 列表类查询必须显式带上这个条件，漏带不会报错，只会让侧边栏被塞满。
     */
    kind: text("kind", { enum: ["main", "subagent"] })
      .notNull()
      .default("main"),
    activeHeadId: text("active_head_id"),
    activeStreamId: text("active_stream_id"),
    status: text("status", {
      enum: ["idle", "running", "wait_review", "done", "canceled", "error"],
    })
      .notNull()
      .default("idle"),
    forkedFromSessionId: text("forked_from_session_id"),
    forkedFromMessageId: text("forked_from_message_id"),
    /**
     * 派生这行的父会话，以及父会话里那次工具调用的 id。
     *
     * 两者一起唯一定位一次 `task` 调用，父 turn 被 resume 时靠它找回同一个子
     * 会话接着跑，而不是再建一个。`main` 行两列都是 null。
     */
    parentSessionId: text("parent_session_id"),
    parentToolCallId: text("parent_tool_call_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("idx_session_kind_created").on(table.kind, table.createdAt),
    uniqueIndex("idx_session_parent_tool_call").on(
      table.parentSessionId,
      table.parentToolCallId
    ),
  ]
);

export type SessionModel = InferSelectModel<typeof session_table>;
export type SessionInsertModel = InferInsertModel<typeof session_table>;
export type SessionStatus = SessionModel["status"];

export const turn_table = sqliteTable(
  "turn",
  {
    id: text("id", { length: 36 })
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    sessionId: text("session_id"),
    type: text("type").notNull(),
    metadata: text("metadata", { mode: "json" }),
    content: text("content", { mode: "json" }).notNull(),
    parentId: text("parent_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("idx_sessionid").on(table.sessionId),
    index("idx_turn_parent").on(table.parentId),
    index("idx_turn_session_parent").on(table.sessionId, table.parentId),
  ]
);

export type TurnModel = InferSelectModel<typeof turn_table>;
export type TurnInsertModel = InferInsertModel<typeof turn_table>;

export const dict_table = sqliteTable("dict", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  content: text("content", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type DictModel = InferSelectModel<typeof dict_table>;
export type DictInsertModel = InferInsertModel<typeof dict_table>;
