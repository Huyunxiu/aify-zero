import type {
  AgentStreamEvent,
  AgentTurn,
  AgentTurnStatus,
} from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

import type { AgentSession } from "../agent-session";
import type { AgentStore } from "../storage";
import { journaledStepTarget } from "../storage/step-journal";
import type { AgentToolSet } from "../types";

export type BeginTurnInput = {
  turnId: string;
  type: AgentTurn<AgentToolSet>["type"];
  parentId?: string;
  startedAt: number;
};

export type SettleTurnInput = {
  turnId: string;
  status: AgentTurnStatus;
  parentId?: string;
};

export interface TranscriptJournalDeps {
  store: AgentStore;
  session: AgentSession;
  sessionId: string;
  /** 当前运行的 id；step 行用它区分本次运行与历史。 */
  streamId(): string | undefined;
}

/** 一行 step 的写入形状，从 store 端口推导，不直接依赖数据库 schema。 */
type StepRow = Parameters<AgentStore["saveStep"]>[0];

/**
 * turn / step 的落库记账。
 *
 * 它只回答两个问题：什么时刻该写哪一行，以及写失败时怎么办。它不知道模型、
 * 工具或事件协议；调用方把已经组装好的 turn 和事件交给它。
 */
export class TranscriptJournal {
  readonly #deps: TranscriptJournalDeps;

  constructor(deps: TranscriptJournalDeps) {
    this.#deps = deps;
  }

  /**
   * 在 `turn.start` 之前把 turn 行写成 `streaming`。
   *
   * 新回合插入一条空 turn；审批恢复复用内存里已有的 turn（它可能已经带
   * step），只把 status 拉回 streaming。parentId 和 createdAt 由 store 的
   * upsert 保留，所以同一次审批恢复仍然落在原来的 branch 节点上。
   */
  async beginTurn({
    turnId,
    type,
    parentId,
    startedAt,
  }: BeginTurnInput): Promise<void> {
    const resumed = this.#deps.session.turns.find((turn) => turn.id === turnId);
    if (resumed) {
      resumed.status = "streaming";
      resumed.completedAt = undefined;
    }

    const content: AgentTurn<AgentToolSet> = resumed ?? {
      id: turnId,
      type,
      createdAt: startedAt,
      status: "streaming",
      content: [],
    };

    await this.#deps.store.beginTurn({
      turn: {
        id: turnId,
        sessionId: this.#deps.sessionId,
        type: content.type,
        metadata: {},
        parentId: parentId ?? null,
        createdAt: new Date(content.createdAt),
        content,
      },
    });
  }

  /**
   * 在 step 到达终态、或被终态更新时写一行 step。
   *
   * 只处理 `journaledStepTarget` 认可的事件；其余事件不写库。写失败只告警，
   * 不打断流——回合本身仍然可以正常收尾。
   */
  async noteStep(event: AgentStreamEvent<AgentToolSet>): Promise<void> {
    const target = journaledStepTarget(event);
    if (!target) {
      return;
    }

    const step = this.#deps.session.assembler?.getStep(target.stepId);
    const turn = this.#deps.session.turns.find(
      (candidate) => candidate.id === target.turnId
    );
    if (!step || !turn) {
      return;
    }

    const seq = turn.content.findIndex((candidate) => candidate.id === step.id);
    if (seq === -1) {
      return;
    }

    const row: StepRow = {
      stepId: step.id,
      turnId: target.turnId,
      sessionId: this.#deps.sessionId,
      seq,
      streamId: this.#deps.streamId() ?? null,
      type: step.type,
      status: step.status,
      content: step,
      createdAt: new Date(step.createdAt),
      updatedAt: new Date(),
    };

    try {
      await this.#deps.store.saveStep(row);
      // 写成功才清账：失败时留着，回合结束的兜底写入会重试。
      this.#deps.session.assembler?.markStepPersisted(step.id);
    } catch (error) {
      logger.warn("[agent] failed to persist step", error);
    }
  }

  /**
   * 收尾一个 turn：先落终态 header，再把本次运行改动过的 turn 回写。
   *
   * @returns 这次运行驱动的 turn，也就是会话要报告结束状态的那一条。
   */
  async settleTurn({
    turnId,
    status,
    parentId,
  }: SettleTurnInput): Promise<AgentTurn<AgentToolSet> | undefined> {
    // 终态先单独落一行：收尾循环还要 settle 并同步 step，进程在两者之间退出
    // 时 turn 行不应该还停在 streaming。写失败只告警，收尾循环会再写一次。
    const finishedTurn = this.#deps.session.turns.find(
      (turn) => turn.id === turnId
    );
    if (finishedTurn) {
      try {
        await this.#deps.store.updateTurn(
          this.#deps.sessionId,
          turnId,
          finishedTurn
        );
      } catch (error) {
        logger.warn("[agent] failed to persist turn header", error);
      }
    }

    // An aborted or failed step returns from `#runStep` before its
    // `step.finish`, so the step and its parts are still pending here; the
    // `turn.finish` above only clears the turn. Settling first keeps the copy
    // persisted below from carrying a `"streaming"` step forever. A `"done"`
    // turn is skipped so a still-streaming background title is not marked —
    // and so is one held for approval, whose step did reach its own end.
    if (status.status === "aborted" || status.status === "error") {
      this.#deps.session.assembler?.settle(status.status);
    }

    // Every turn the stream changed is written back, not just the one that
    // finished: a stream that resumes a held call runs that call and reports
    // its result against the turn that asked for it — a turn that ended turns
    // ago — so writing back only the ending would leave the store holding the
    // unanswered state of a call that has since been answered.
    //
    // Only the step rows still carrying a change are written. Everything else
    // was journaled when it reached its end, so the usual turn ends with no
    // step write at all; what remains is the resumed call's old step and any
    // step whose journal write failed.
    const changedTurns = this.#deps.session.assembler?.changedTurns ?? [];
    const changedStepIds = new Set(
      (this.#deps.session.assembler?.changedSteps ?? []).map(
        (changed) => changed.stepId
      )
    );

    for (const changed of changedTurns) {
      // `rowsAffected` doubles as the existence check: 0 means the turn row was
      // never written, which is the one case that needs an insert.
      const updated = await this.#deps.store.updateTurn(
        this.#deps.sessionId,
        changed.id,
        changed,
        { stepIds: changedStepIds }
      );
      if (updated === 0) {
        await this.#deps.store.saveTurn(
          {
            id: changed.id,
            sessionId: this.#deps.sessionId,
            type: changed.type,
            metadata: {},
            content: changed,
            parentId: parentId ?? null,
            createdAt: new Date(changed.createdAt),
          },
          { head: true }
        );
      }
    }

    return changedTurns.findLast((changed) => changed.id === turnId);
  }

  /**
   * 回写一条跨 turn 恢复的旧 step。
   *
   * 审批恢复会把工具结果写回当初挂起调用的 step；journal 不覆盖跨 turn 的
   * 回写，所以调用方在下一步之前显式落一次。只写这一条 step：整条 turn
   * 重写会把同一 turn 里早已落库的其他 step 也带上一遍。
   */
  async persistStep(turnId: string, stepId: string): Promise<void> {
    const turn = this.#deps.session.turns.find(
      (candidate) => candidate.id === turnId
    );
    if (!turn) {
      return;
    }

    await this.#deps.store.updateTurn(this.#deps.sessionId, turn.id, turn, {
      stepIds: new Set([stepId]),
    });
  }
}
