import type { AgentTurn } from "@workspace/agent-client";
import type { SessionModel } from "@workspace/db";
import { logger } from "@workspace/shared/logger";

import type { SessionEndStatus } from ".";
import type { TurnRecord } from "./turn-record";

/** 崩溃收尾时写进 turn.error 的固定文案。 */
export const INTERRUPTED_TURN_ERROR =
  "The run stopped before this turn finished.";

/**
 * 启动恢复只需要这几项能力；`SQLiteStore` 和测试替身都实现它。
 *
 * `getBranchTurns` 故意不传 `activeStreamId`：恢复要看的是全部已经落库的
 * step，而不是“当前运行”的可见子集。
 */
export type RecoveryStore = {
  listInterruptedSessions(): Promise<SessionModel[]>;
  getBranchTurns(sessionId: string): Promise<TurnRecord[]>;
  updateTurnHeader(id: string, turn: AgentTurn): Promise<number>;
  clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus
  ): Promise<number>;
  /** 把会话里残留的 next-step 消息提升为 next-turn；返回提升的行数。 */
  promoteStaleInboxMessages(sessionId: string): Promise<number>;
};

export type RecoveryOutcome = {
  sessionId: string;
  settledTurnId?: string;
};

/**
 * 收尾上一个进程留下的运行。
 *
 * 启动时内存里的流注册表是空的，所以任何 `activeStreamId` 都属于已经退出的
 * 进程。对每个这样的会话：
 *
 * - 有 streaming turn：把它标成 `error`，保留已经落库的 step；
 * - 没有 streaming turn：turn 已经结束或根本没开始，只按 branch 末尾推导
 *   会话状态，然后清标记。
 *
 * 单会话失败不抛出、也不清标记：下次启动会再试。step 行一律不改——表里只有
 * 到达过 `step.finish` 的 step，模型历史天然合法；崩溃时正在执行的 step 没有
 * 行，按设计丢弃。
 */
export async function recoverInterruptedRuns(
  store: RecoveryStore
): Promise<RecoveryOutcome[]> {
  const sessions = await store.listInterruptedSessions();
  const outcomes: RecoveryOutcome[] = [];

  for (const session of sessions) {
    const streamId = session.activeStreamId;
    if (!streamId) {
      continue;
    }

    try {
      const branch = await store.getBranchTurns(session.id);
      let settledTurnId: string | undefined;

      for (const turn of branch) {
        if (turn.content.status !== "streaming") {
          continue;
        }

        const lastStep = turn.content.content.at(-1);
        const completedAt =
          lastStep?.completedAt ??
          lastStep?.createdAt ??
          turn.content.createdAt;
        const settled = {
          ...turn.content,
          status: "error",
          error: INTERRUPTED_TURN_ERROR,
          completedAt,
        } as AgentTurn;

        await store.updateTurnHeader(turn.id, settled);
        settledTurnId = turn.id;
      }

      const status: SessionEndStatus = settledTurnId
        ? "error"
        : statusOfHead(branch, session.activeHeadId);

      await store.clearActiveStream(session.id, streamId, status);

      // 上个进程留下的 next-step 已经没有“下一步”了：提升成下一回合的排队
      // 消息，否则它们永远不会被发送。提升失败不影响收尾，下次启动会再试。
      try {
        await store.promoteStaleInboxMessages(session.id);
      } catch (error) {
        logger.warn(
          `[recovery] failed to promote pending messages for ${session.id}`,
          error
        );
      }

      outcomes.push({
        sessionId: session.id,
        ...(settledTurnId ? { settledTurnId } : {}),
      });
      logger.warn(
        `[recovery] settled interrupted session ${session.id}${
          settledTurnId ? ` at turn ${settledTurnId}` : ""
        }`
      );
    } catch (error) {
      logger.warn(
        `[recovery] failed to settle interrupted session ${session.id}`,
        error
      );
    }
  }

  return outcomes;
}

/**
 * 没有 streaming turn 时，按 branch 末尾推导会话状态。
 *
 * assistant 的终态直接映射；user turn 说明回复根本没开始，压缩 turn 不是模型
 * 回复（手工压缩原本也不该改写会话状态），两者都退回 `error` / `idle`。
 */
function statusOfHead(
  branch: TurnRecord[],
  activeHeadId: string | null
): SessionEndStatus {
  const head = activeHeadId
    ? branch.find((turn) => turn.id === activeHeadId)
    : branch.at(-1);

  if (!head) {
    return "error";
  }
  if (head.content.type === "compaction") {
    return "idle";
  }
  if (head.content.type !== "assistant") {
    return "error";
  }

  const { status } = head.content;
  if (status === "done") {
    return "done";
  }
  if (status === "wait_review") {
    return "wait_review";
  }
  if (status === "aborted") {
    return "canceled";
  }

  return "error";
}
