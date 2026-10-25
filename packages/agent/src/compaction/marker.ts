import type {
  AgentCompactionStep,
  AgentCompactionTurn,
  AgentStep,
  CompactionRecord,
} from "@workspace/agent-client";

import {
  generateEventId,
  generateStepId,
  generateTurnId,
} from "../utils/id-util";

/**
 * 构造标记一次压缩的 step。
 *
 * 记录是整体提交的，所以 part 直接是 `"done"`，没有需要流式拼装的内容。
 */
export function createCompactionStep(
  record: CompactionRecord
): AgentCompactionStep {
  return {
    id: generateStepId(),
    type: "compaction",
    createdAt: record.createdAt,
    status: "done",
    completedAt: record.createdAt,
    model: record.model,
    content: [
      {
        type: "compaction",
        id: record.id || generateEventId(),
        state: "done",
        createdAt: record.createdAt,
        // 手工压缩没有流式过程，因此没有可展示的耗时。
        record,
      },
    ],
  };
}

/**
 * 构造手工压缩追加或插入的独立 turn。
 *
 * 它只包含一个标记 step；这条 turn 是 branch 上的一个节点，标记的位置就是切点。
 */
export function createCompactionTurn(
  record: CompactionRecord
): AgentCompactionTurn {
  const step = createCompactionStep(record);
  return {
    id: generateTurnId(),
    type: "compaction",
    createdAt: record.createdAt,
    completedAt: record.createdAt,
    status: "done",
    content: [step],
  };
}

/** 取压缩 step 携带的记录；不是压缩 step 或没有记录时返回 undefined。 */
export function compactionRecordOf(
  step: AgentStep<any>
): CompactionRecord | undefined {
  if (step.type !== "compaction") {
    return undefined;
  }

  for (const part of step.content) {
    if (part.type === "compaction" && part.record) {
      return part.record;
    }
  }

  return undefined;
}
