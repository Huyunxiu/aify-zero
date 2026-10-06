import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, index, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const session_table = sqliteTable("session", {
  id: text("id", { length: 36 })
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  title: text("title").notNull(),
  metadata: text("metadata", { mode: "json" }),
  activeHeadId: text("active_head_id"),
  activeStreamId: text("active_stream_id"),
  status: text("status", {
    enum: ["idle", "running", "wait_review", "done", "canceled", "error"],
  })
    .notNull()
    .default("idle"),
  forkedFromSessionId: text("forked_from_session_id"),
  forkedFromMessageId: text("forked_from_message_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

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
