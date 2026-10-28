import type { AgentStep, AgentTurn } from "@workspace/agent-client";
import type {
  StepInsertModel,
  StepModel,
  TurnInsertModel,
  TurnModel,
} from "@workspace/db";
import type {
  FinishReason,
  LanguageModelUsage,
  ProviderMetadata,
  StepResultPerformance,
} from "ai";

import type { AgentToolSet } from "../types";

/**
 * turn 行上除 step 之外的字段。
 *
 * 这些字段属于 turn 本身，不属于任何 step；它们以 JSON 存在 `turn.detail`
 * 里，读取时再展开回 `AgentTurn`。
 */
export type TurnDetail = {
  usage?: LanguageModelUsage;
  performance?: StepResultPerformance;
  finishReason?: FinishReason;
  rawFinishReason?: string;
  providerMetadata?: ProviderMetadata;
  error?: unknown;
  abortReason?: string;
};

/**
 * 写一条 turn 所需的行字段。
 *
 * `status`/`detail`/`completedAt` 不在这里：它们由 `content` 推导，避免调用方
 * 同时维护两份状态。
 */
export type TurnWrite = {
  id: string;
  sessionId: string;
  type: TurnModel["type"];
  metadata?: unknown;
  parentId?: string | null;
  createdAt: Date;
  content: AgentTurn<AgentToolSet>;
};

/**
 * 一条读出的 turn：数据库行 + 由 step 表拼出的 content。
 *
 * `content` 不再是数据库列；它只在内存里存在，供 agent、server 和 UI 使用。
 */
export type TurnRecord = TurnModel & {
  content: AgentTurn<AgentToolSet>;
};

/** 从完整 turn 中取出要落进 `turn.detail` 的字段；只保留有值的。 */
export function turnDetailOf(turn: AgentTurn): TurnDetail {
  const detail: TurnDetail = {};

  if (turn.usage !== undefined) {
    detail.usage = turn.usage;
  }
  if (turn.performance !== undefined) {
    detail.performance = turn.performance;
  }
  if (turn.finishReason !== undefined) {
    detail.finishReason = turn.finishReason;
  }
  if (turn.rawFinishReason !== undefined) {
    detail.rawFinishReason = turn.rawFinishReason;
  }
  if (turn.providerMetadata !== undefined) {
    detail.providerMetadata = turn.providerMetadata;
  }
  if (turn.status === "error") {
    detail.error = turn.error;
  }
  if (turn.status === "aborted") {
    detail.abortReason = turn.abortReason;
  }

  return detail;
}

/** 把一条完整 turn 转成 turn 行；status/detail/completedAt 从 content 推导。 */
export function toTurnRow(turn: TurnWrite): TurnInsertModel {
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    type: turn.type,
    metadata: turn.metadata ?? {},
    parentId: turn.parentId ?? null,
    status: turn.content.status,
    detail: turnDetailOf(turn.content),
    completedAt:
      turn.content.completedAt === undefined
        ? null
        : new Date(turn.content.completedAt),
    createdAt: turn.createdAt,
    updatedAt: new Date(),
  };
}

/**
 * 把一条完整 turn 的 step 转成 step 行。
 *
 * `seq` 就是数组下标：turn 内的 step 只追加、不重排，所以下标是稳定的。
 * `streamId` 记录产生这些 step 的运行；老数据或非流式写入传 `undefined`。
 */
export function toStepRows({
  turnId,
  sessionId,
  content,
  streamId,
}: {
  turnId: string;
  sessionId: string;
  content: AgentTurn;
  streamId?: string;
}): StepInsertModel[] {
  return content.content.map((step, seq) => ({
    id: step.id,
    turnId,
    sessionId,
    seq,
    streamId: streamId ?? null,
    type: step.type,
    status: step.status,
    content: step,
    createdAt: new Date(step.createdAt),
    updatedAt: new Date(),
  }));
}

/**
 * 把 turn 行和 step 行拼回 `AgentTurn`。
 *
 * streaming turn 只隐藏“当前运行”的 step：客户端会用流的重放重建这些 step，
 * 提前返回会让文本和工具调用重复。上一次运行留下的 step（例如审批恢复前的那
 * 一段）必须保留，否则页面刷新会丢掉已经显示过的内容。
 */
export function hydrateTurn(
  row: TurnModel,
  steps: StepModel[],
  activeStreamId?: string
): TurnRecord {
  const visibleSteps =
    row.status === "streaming" && activeStreamId !== undefined
      ? steps.filter((step) => step.streamId !== activeStreamId)
      : steps;

  const content = {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt.getTime(),
    status: row.status,
    ...(row.completedAt === null
      ? {}
      : { completedAt: row.completedAt.getTime() }),
    ...compactDetail(row.detail),
    content: [...visibleSteps]
      .toSorted((left, right) => left.seq - right.seq)
      .map((step) => step.content as AgentStep<AgentToolSet>),
  } as AgentTurn<AgentToolSet>;

  return { ...row, content };
}

/**
 * 剔除 `detail` 里的 null。
 *
 * SQL 迁移用 `json_object` 生成 detail 时会把缺失字段写成 null；内存里的
 * `AgentTurn` 期望的是“字段不存在”，所以读取时统一去掉。
 */
function compactDetail(detail: unknown): TurnDetail {
  if (detail === null || typeof detail !== "object") {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    detail as Record<string, unknown>
  )) {
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  }

  return result as TurnDetail;
}
