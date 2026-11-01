import type { AgentTurn, AgentTurnStatus } from "@workspace/agent-client";
import { getErrorMessage } from "@workspace/shared/errors";
import { APICallError } from "ai";

import type { AgentContext } from "../agent-context";
import type { AgentSession } from "../agent-session";
import type { HookContext, HooksManager } from "../hooks-manager";
import type { AgentInbox } from "../inbox/agent-inbox";
import type { AgentToolSet } from "../types";
import { convertStepToModelMessages } from "../utils/convert-to-model-message";
import { generateStepId } from "../utils/id-util";
import type { CompactionController } from "./compaction-controller";
import type { StepRunner } from "./step-runner";
import type { TranscriptJournal } from "./transcript-journal";

export type TurnInput = {
  readonly turnType: AgentTurn<AgentToolSet>["type"];
  readonly turnId: string;
  readonly parentId?: string;
  /** 这一轮是否追加了新的 user turn；只有这种情况下才做回合前压缩。 */
  readonly startedFromUserTurn: boolean;
};

export interface TurnRunnerDeps {
  session: AgentSession;
  context: AgentContext;
  inbox: AgentInbox;
  sessionId: string;
  stepRunner: StepRunner;
  compaction: CompactionController;
  journal: TranscriptJournal;
  hooks: HooksManager;
  extensionApi: HookContext;
  /** 当前运行的 id；steering step 需要它。 */
  streamId(): string | undefined;
}

/**
 * Drives one assistant turn: repeated steps until the model stops asking for
 * tools, the step budget runs out, or a step is aborted or fails.
 *
 * 它不创建流、不关流；RunController 负责一次运行的生命周期，这里只负责
 * turn 内部的循环、压缩时机和 steering。
 */
export class TurnRunner {
  readonly #deps: TurnRunnerDeps;

  constructor(deps: TurnRunnerDeps) {
    this.#deps = deps;
  }

  async run(input: TurnInput): Promise<AgentTurn<AgentToolSet> | undefined> {
    const { session, context, compaction, journal, stepRunner } = this.#deps;
    const { turnId } = input;

    compaction.resetTurn();

    // 在 assistant turn 打开之前执行，让标记落在上一条回复末尾：新的用户消息
    // 保持原文。
    if (input.startedFromUserTurn) {
      await compaction.maybeCompact({
        trigger: "pressure",
        mode: "before-turn",
      });
    }

    // 先把 turn 行写成 streaming 再发 turn.start：这一行是崩溃标记，必须在
    // 任何 step 事件之前就存在。
    const startedAt = Date.now();
    await journal.beginTurn({
      turnId,
      type: input.turnType,
      parentId: input.parentId,
      startedAt,
    });

    await context.controller?.write({
      type: "turn.start",
      turnId,
      turnType: "assistant",
      createdAt: startedAt,
    });

    // turn 行已经存在：后台任务（标题生成）从这里开始，它们的协议事件挂在这个
    // turn 上。处理器自己决定是否真的启动，这里只报告事实。
    await this.#deps.hooks.emit(
      "turn_created",
      { sessionId: this.#deps.sessionId, turnId, modelId: context.modelId },
      this.#deps.extensionApi
    );

    let status: AgentTurnStatus = { status: "done" };
    let ending: AgentTurnStatus | undefined;
    // 上一步是否留下了可以继续的完整历史。只有这种边界才允许把引导消息
    // 插进当前 turn。
    let steeringAllowed = false;
    let firstStep = true;
    while (true) {
      if (!firstStep) {
        await compaction.maybeCompact({
          trigger: "pressure",
          mode: "end",
          turnId,
        });
      }

      // 先把 next-step 消息插进当前 turn，再开下一步。纯文本步默认要结束，
      // 但如果这里领到了引导消息，ending 被清掉，循环继续跑下一步。
      if (
        !firstStep &&
        steeringAllowed &&
        (await this.#applySteering(turnId))
      ) {
        ending = undefined;
        steeringAllowed = false;
      } else if (ending) {
        status = ending;
        break;
      }

      firstStep = false;

      const stepId = generateStepId();

      const outcome = await stepRunner.run({
        turnId,
        stepId,
        stepType: "assistant",
      });

      if (!outcome.ok) {
        if (outcome.reason === "aborted") {
          status = { status: "aborted" };
        } else {
          status = { status: "error", error: outcome.error };
          status.error =
            status.error instanceof APICallError
              ? status.error.responseBody
              : getErrorMessage(status.error);
        }
        break;
      }

      session.finishStep(outcome.result);

      // The step asked the user for something, so the turn stops here rather
      // than with it: a step is what the loop continues from, and it cannot
      // continue past a call nobody has answered yet.
      if (outcome.result.awaitingApproval) {
        ending = { status: "wait_review" };
        steeringAllowed = false;
        continue;
      }

      // 非法/没有结果的工具调用让历史不完整，不能在上面追加 user 消息；
      // 回合在这里结束，残留的 next-step 由收尾逻辑提升为 next-turn。
      if (outcome.result.unresolvedToolCalls) {
        ending = { status: "done" };
        steeringAllowed = false;
        continue;
      }

      // 工具调用全部完成：照旧让模型读结果，下一步前会检查引导消息。
      if (outcome.result.toolCallsResolved) {
        steeringAllowed = true;
        continue;
      }

      // 纯文本步：默认收尾；若引导消息在下一轮顶部被领到，就继续。
      ending = { status: "done" };
      steeringAllowed = true;
    }

    await context.controller?.write({
      turnId,
      type: "turn.finish",
      createdAt: Date.now(),
      usage: session.usage,
      ...status,
    });

    // 终态 header 与本次运行改动过的 turn 由 journal 统一回写；返回本次运行
    // 驱动的 turn，会话据此报告结束状态。
    return await journal.settleTurn({
      turnId,
      status,
      parentId: input.parentId,
    });
  }

  /**
   * 把 Inbox 里待应用的引导消息插进当前 assistant turn。
   *
   * 只在步边界调用，而且调用方必须先确认上一步留下了完整历史。事务里删除
   * Inbox 行并写入 steering step；随后发 `turn.steer` 事件，再把对应的 user
   * 消息追加到模型历史。它不开启新的 turn。
   *
   * @returns 是否应用了至少一条消息。
   */
  async #applySteering(turnId: string): Promise<boolean> {
    const { session, context, inbox, sessionId } = this.#deps;
    if (context.abortSignal?.aborted) {
      return false;
    }

    const streamId = this.#deps.streamId();
    if (!streamId) {
      return false;
    }

    const pending = await inbox.listSteering(sessionId);
    if (pending.length === 0) {
      return false;
    }

    // 只有仍然存在于表里的 id 会被领取；被取消或并发领走的行不会变成 step。
    const steps = await inbox.applySteeringSteps({
      sessionId,
      turnId,
      streamId,
      messageIds: pending.map((message) => message.id),
    });
    if (steps.length === 0) {
      return false;
    }

    for (const step of steps) {
      await context.controller?.write({
        type: "turn.steer",
        turnId,
        step,
        createdAt: Date.now(),
      });

      // `applySteeringSteps` 在领取消息的同一个事务里写好了这条 step 行，
      // 事件只是把它带进内存；回合结束不必再写一次。
      session.assembler?.markStepPersisted(step.id);

      // 模型在下一步读到的就是这条 user 消息，位置在上一 step 的工具结果之后。
      session.modelMessages.push(...(await convertStepToModelMessages(step)));
    }

    return true;
  }
}
