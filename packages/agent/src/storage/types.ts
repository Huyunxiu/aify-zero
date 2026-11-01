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

/** 一条 turn 行；`content` 由 step 表拼出，不在行里。 */
export type TurnRow = {
  id: string;
  sessionId: string | null;
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
  id: string;
  sessionId: string;
  type: string;
  metadata?: unknown;
  parentId?: string | null;
  createdAt: Date;
  content: AgentTurn<AgentToolSet>;
};

/** 一条读出的 turn：turn 行 + 由 step 表拼出的 content。 */
export type TurnRecord = TurnRow & {
  content: AgentTurn<AgentToolSet>;
};

/** 一行 step；`seq` 是它在 turn 内的下标。 */
export type StepRow = {
  id: string;
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

/** 写一条 step 行。 */
export type StepWrite = StepRow;
