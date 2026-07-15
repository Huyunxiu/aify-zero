import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const session_table = sqliteTable("session", {
  id: text("id", { length: 36 })
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  title: text("title").notNull(),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type SessionModel = InferSelectModel<typeof session_table>;
export type SessionInsertModel = InferInsertModel<typeof session_table>;

export const message_table = sqliteTable(
  "message",
  {
    id: text("id", { length: 36 })
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    sessionId: text("session_id"),
    role: text("role").notNull(),
    metadata: text("metadata", { mode: "json" }),
    content: text("content", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("idx_sessionid").on(table.sessionId)]
);

export type MessageModel = InferSelectModel<typeof message_table>;
export type MessageInsertModel = InferInsertModel<typeof message_table>;

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
