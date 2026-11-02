import type { AgentStep, AgentTurn } from "@workspace/agent-client";

import type { AgentToolSet } from "../types";

export type SessionKind = "main" | "subagent";

export type SessionStatus =
  | "idle"
  | "running"
  | "wait_review"
  | "done"
  | "canceled"
  | "error";

export type SessionEndStatus = Exclude<SessionStatus, "running">;

/** 一条会话行；字段与持久化层的列一一对应，但不依赖数据库包。 */
export type SessionRecord = {
  id: string;
  title: string;
  metadata: unknown;
  projectId: string | null;
  kind: SessionKind;
  activeHeadId: string | null;
  activeStreamId: string | null;
  status: SessionStatus;
  forkedFromSessionId: string | null;
  forkedFromMessageId: string | null;
  parentSessionId: string | null;
  parentToolCallId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 写一条会话行；缺省字段由适配器补默认值。 */
export type SessionWrite = {
  id: string;
  title: string;
  metadata?: unknown;
  projectId?: string | null;
  kind?: SessionKind;
  activeHeadId?: string | null;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
  parentSessionId?: string | null;
  parentToolCallId?: string | null;
};

export type TurnStatus =
  | "streaming"
  | "done"
  | "wait_review"
  | "aborted"
  | "error";

/** 一条 turn 行的领域字段；物理 `rowId` 由存储适配器生成，不在这里。 */
export type TurnRow = {
  turnId: string;
  sessionId: string;
  type: string;
  metadata: unknown;
  parentId: string | null;
  status: TurnStatus;
  detail: unknown;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 写一条 turn 所需的行字段；status/detail/completedAt 由 content 推导。 */
export type TurnWrite = {
  /** 业务 turn id；只在会话内唯一，fork 复制时保持不变。 */
  id: string;
  sessionId: string;
  type: string;
  metadata?: unknown;
  parentId?: string | null;
  createdAt: Date;
  content: AgentTurn<AgentToolSet>;
};

/** 从存储读出的 turn 行；`rowId` 是物理自增主键，不进领域对象。 */
export type TurnTableRow = TurnRow & { rowId: number };

/** 一条读出的 turn：turn 行 + 由 step 表拼出的 content。 */
export type TurnRecord = Omit<TurnTableRow, "rowId" | "turnId"> & {
  /** 业务 turn id，与 `content.id` 相同。 */
  id: string;
  content: AgentTurn<AgentToolSet>;
};

/** 写一条 step 行；物理 `rowId` 由存储适配器生成，不在这里。 */
export type StepWrite = {
  /** 业务 step id；只在会话内唯一。 */
  stepId: string;
  turnId: string;
  sessionId: string;
  seq: number;
  streamId: string | null;
  type: AgentStep<AgentToolSet>["type"];
  status: AgentStep<AgentToolSet>["status"];
  content: AgentStep<AgentToolSet>;
  createdAt: Date;
  updatedAt: Date;
};

/** 一行 step；`rowId` 是物理自增主键。 */
export type StepRow = StepWrite & { rowId: number };
