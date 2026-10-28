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

export const project_table = sqliteTable(
  "project",
  {
    id: text("id", { length: 36 })
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * 主目录的绝对路径。
     *
     * 工具的相对路径、skill 和 context 文件的加载都以它为基准，对应
     * `AgentContext.projectDirs` 的第一项。
     */
    primaryDir: text("primary_dir").notNull(),
    /**
     * 主目录之外额外可访问的根，绝对路径。
     *
     * 模型访问它们时必须用绝对路径，彼此之间没有顺序语义。约定不包含
     * `primaryDir`，由写入方在创建/更新项目时校验。
     *
     * 读取端的映射：`projectDirs = [primaryDir, ...additionalDirs]`。
     */
    additionalDirs: text("additional_dirs", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    config: text("config", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  // 一个目录只能是一个项目的主目录，否则资源加载会出现两份来源。
  (table) => [uniqueIndex("idx_project_primary_dir").on(table.primaryDir)]
);

export type ProjectModel = InferSelectModel<typeof project_table>;
export type ProjectInsertModel = InferInsertModel<typeof project_table>;

export const session_table = sqliteTable(
  "session",
  {
    id: text("id", { length: 36 })
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    title: text("title").notNull(),
    metadata: text("metadata", { mode: "json" }),
    /**
     * 会话所属的项目。
     *
     * 可空是为了兼容这张表加列之前建立的会话：它们没有项目归属，按项目过滤
     * 时不会出现在任何项目里。子会话与 fork 出来的会话继承源会话的值。
     */
    projectId: text("project_id"),
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
    // 按项目列会话的热路径：先按项目收窄，再按 kind 排除子 agent，最后排序。
    index("idx_session_project_kind_created").on(
      table.projectId,
      table.kind,
      table.createdAt
    ),
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
    parentId: text("parent_id"),
    status: text("status", {
      enum: ["streaming", "done", "wait_review", "aborted", "error"],
    })
      .notNull()
      .default("done"),
    /**
     * turn 级可变字段，不属于任何 step。
     *
     * 包含 `usage`、`performance`、`finishReason`、`rawFinishReason`、
     * `providerMetadata`、`error` 和 `abortReason`。做成 JSON 而不是逐列，
     * 是因为这些字段只被整体读回 `AgentTurn`，没有按列查询的需求。
     */
    detail: text("detail", { mode: "json" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
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

/**
 * 一条 turn 里的一个 step。
 *
 * 这张表是 step 的唯一存储；`turn` 表不再保存 step 数组。`seq` 是 turn 内
 * 序号，从 0 开始、只追加、不重排；`streamId` 记录产生该 step 的那次运行，
 * 读取时用它隐藏“当前运行”的 step，避免和流重放重复。
 *
 * `content` 存完整 `AgentStep` JSON；`type` / `status` 是供查询用的冗余列，
 * 与 `content` 里的同名字段保持一致。
 */
export const step_table = sqliteTable(
  "step",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    streamId: text("stream_id"),
    type: text("type").notNull(),
    status: text("status", {
      enum: ["streaming", "done", "wait_review", "aborted", "error"],
    }).notNull(),
    content: text("content", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("idx_step_turn_seq").on(table.turnId, table.seq),
    index("idx_step_session_created").on(table.sessionId, table.createdAt),
  ]
);

export type StepModel = InferSelectModel<typeof step_table>;
export type StepInsertModel = InferInsertModel<typeof step_table>;

/**
 * 会话待发送的消息。
 *
 * `next-step` 表示它是回合运行中补的引导消息，下一个模型步边界领取；
 * `next-turn` 表示它等当前回合结束后作为新回合发送。领取成功就删除这一行，
 * 消息本身随后写进 `turn` / `step`。
 *
 * `seq` 自增，保证 FIFO；`(session_id, request_id)` 唯一，客户端重试不会重复
 * 入队。`content` 存完整的 `AgentUserTurn`，`payload` 存发送所需的模型信息。
 */
export const inbox_message_table = sqliteTable(
  "inbox_message",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id")
      .notNull()
      .unique()
      .$defaultFn(() => randomUUID()),
    sessionId: text("session_id").notNull(),
    requestId: text("request_id").notNull(),
    placement: text("placement", {
      enum: ["next-step", "next-turn"],
    }).notNull(),
    content: text("content", { mode: "json" }).notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("idx_inbox_session_request").on(
      table.sessionId,
      table.requestId
    ),
    index("idx_inbox_session_placement_seq").on(
      table.sessionId,
      table.placement,
      table.seq
    ),
  ]
);

export type InboxMessageModel = InferSelectModel<typeof inbox_message_table>;
export type InboxMessageInsertModel = InferInsertModel<
  typeof inbox_message_table
>;

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
