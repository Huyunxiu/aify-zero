import {
  addToolApprovalResponse,
  findToolApprovalRequests,
  findTurnWithoutToolResult,
} from "@workspace/agent-client";
import type {
  AgentTurn,
  AgentUserTurn,
  InboxItem,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import type { ModelEffort } from "@workspace/shared/constants";
import { logger } from "@workspace/shared/logger";
import type { ModelRef } from "@workspace/shared/model";

import { AgentSession } from "../agent-session";
import type { Agent } from "../agents";
import type { SteeringSignal } from "../inbox/steering";
import type { JobRegistry } from "../jobs/registry";
import type { InboxClaim } from "../kernel/run-types";
import { hasVisibleText } from "../outbox/text";
import type { OutboxRecorder } from "../outbox/types";
import type { AgentStore, SessionEndStatus, TurnWrite } from "../storage";
import type { StreamEventRegistry } from "../stream-registry";
import type { AgentToolSet } from "../types";
import { generateSessionId } from "../utils/id-util";
import { AgentRunnerError } from "./errors";
import type { BuildAgentInput, RunStart, StartedRun } from "./types";

export type CreateInput = {
  sessionId: string;
  turns: AgentTurn<AgentToolSet>[];
  approvals?: TextStreamToolApprovalResponseEvent[];
  model: ModelRef;
  effort?: ModelEffort;
  projectId?: string;
};

export type StartFromInboxResult = StartedRun;

export type CompactInput = {
  sessionId: string;
  model: ModelRef;
  effort?: ModelEffort;
  /** 压缩这条流落定之后调一次；运行器用它唤醒队列。 */
  onSettled?: () => void;
};

export type ForkInput = {
  sessionId: string;
  messageId?: string;
};

export interface SessionLifecycleDeps {
  store: AgentStore;
  registry: StreamEventRegistry<AgentToolSet>;
  buildAgent: (input: BuildAgentInput) => Promise<Agent>;
  jobs?: JobRegistry;
  /** 按会话取插话信号；没有时等待只能靠中止或超时结束。 */
  steering?: (sessionId: string) => SteeringSignal;
  /** 一次运行落定、且它确实说了话时留一条发件箱记录；没有就什么都不记。 */
  outbox?: OutboxRecorder;
}

/**
 * 会话的生命周期：开回合、停回合、手工压缩和 fork。
 *
 * 它不决定“什么时候跑”；那是运行器的事。这里的每个方法都只依赖 store、
 * 注册表和宿主的 `buildAgent`，不依赖设置、供应商或 HTTP。
 */
export class SessionLifecycle {
  readonly #deps: SessionLifecycleDeps;

  constructor(deps: SessionLifecycleDeps) {
    this.#deps = deps;
  }

  /**
   * 为一个会话开一次运行。
   *
   * 审批恢复也走这里：答复先写回对应的 step，如果还有待答的调用，就只返回
   * 数量，不启动新的流。
   */
  async create(input: CreateInput): Promise<RunStart> {
    const { sessionId, turns, approvals, model, effort } = input;
    const { store } = this.#deps;

    const mostRecentTurn = turns.at(-1);
    if (!mostRecentTurn && !approvals?.length) {
      throw new Error("no message.");
    }

    // 项目在会话行落库时固定：行已存在就沿用行上的项目，输入值只在首次
    // 落库时生效。
    const previousSession = await store.getSessionById(sessionId);
    const sessionProjectId = previousSession
      ? (previousSession.projectId ?? undefined)
      : input.projectId;

    this.#assertIdle(sessionId);

    const previousMessages = await store.getBranchTurns(sessionId, {
      activeStreamId: previousSession?.activeStreamId ?? undefined,
    });
    const previousTurns = AgentSession.toAgentTurns(previousMessages);
    const originalTurns = mostRecentTurn
      ? [...previousTurns, mostRecentTurn]
      : previousTurns;
    const session = new AgentSession({ turns: originalTurns });

    if (approvals?.length) {
      const changedTurns = addToolApprovalResponse(session.turns, approvals);
      // 每个答复只改它指名的那条 step；整条 turn 重写会把同一 turn 里的大
      // 工具结果也带上，回写量随 turn 大小线性增长。
      const stepIds = new Set(approvals.map((approval) => approval.stepId));
      for (const turn of changedTurns) {
        await store.updateTurn(sessionId, turn.id, turn, { stepIds });
      }
      const toolParts = findToolApprovalRequests(session.turns);
      if (toolParts.length > 0) {
        return { status: "held", awaitingToolApprovals: toolParts.length };
      }
    }

    const { activeStreamId, settled } = await this.#startRun({
      sessionId,
      turns: originalTurns,
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(sessionProjectId === undefined
        ? {}
        : { projectId: sessionProjectId }),
    });

    return { status: "running", activeStreamId, settled };
  }

  /**
   * 审批恢复：把答复写回它指名的 step，再从这条 branch 起一次运行。
   */
  async resume(input: {
    sessionId: string;
    approvals: TextStreamToolApprovalResponseEvent[];
    model: ModelRef;
    effort?: ModelEffort;
  }): Promise<RunStart> {
    return await this.create({
      sessionId: input.sessionId,
      turns: [],
      approvals: input.approvals,
      model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    });
  }

  /**
   * 从收件箱领走一批待办项，开一次运行。
   *
   * 领取和写 turn 在同一个事务里完成（`inboxIds` 一路传给 store）：一条都没
   * 领到就抛 `InboxItemNotFoundError`，调用方据此知道整批已经被别人领走。
   * 模型与 effort 取批里最后一条，那是最新的意图。
   */
  async startFromInbox({
    sessionId,
    items,
  }: {
    sessionId: string;
    items: readonly InboxItem[];
  }): Promise<StartedRun> {
    const { store } = this.#deps;
    const latest = items.at(-1);
    if (!latest) {
      throw new Error("startFromInbox needs at least one item");
    }

    const session = await store.getSessionById(sessionId);
    if (!session) {
      throw new AgentRunnerError("SESSION_NOT_FOUND", { sessionId });
    }
    if (session.kind !== "main") {
      // 子会话的运行归创建它的工具调用，收件箱不是它的入口。
      throw new AgentRunnerError("SESSION_NOT_RUNNABLE", {
        sessionId,
        kind: session.kind,
      });
    }

    this.#assertIdle(sessionId);

    const branch = await store.getBranchTurns(sessionId, {
      activeStreamId: session.activeStreamId ?? undefined,
    });

    const effort =
      typeof latest.payload.modelEffort === "string"
        ? (latest.payload.modelEffort as ModelEffort)
        : undefined;
    const projectId =
      latest.payload.projectId ?? session.projectId ?? undefined;

    return await this.#startRun({
      sessionId,
      turns: AgentSession.toAgentTurns(branch),
      model: latest.payload.model,
      ...(effort === undefined ? {} : { effort }),
      ...(projectId === undefined ? {} : { projectId }),
      claims: items.map((item) => ({ inboxId: item.id, turn: item.content })),
    });
  }

  /**
   * 起跑一次运行，并给出它落定时的状态。
   *
   * `settled` 由 `onFinish` 直接兑现：调用方（运行器）不用回读会话行就知道
   * 这一次跑成了什么。`onFinish` 里抛错也要兑现，否则等它的人会一直等。
   */
  async #startRun(input: {
    sessionId: string;
    turns: AgentTurn<AgentToolSet>[];
    model: ModelRef;
    effort?: ModelEffort;
    projectId?: string;
    claims?: readonly InboxClaim[];
  }): Promise<StartedRun> {
    const { sessionId, turns, model, effort, projectId, claims } = input;
    const { store, registry, buildAgent } = this.#deps;

    const agent = await buildAgent({
      sessionId,
      session: new AgentSession({ turns }),
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(projectId === undefined ? {} : { projectId }),
      streams: registry,
      ...(this.#deps.jobs === undefined ? {} : { jobs: this.#deps.jobs }),
      ...(this.#deps.steering === undefined
        ? {}
        : { steering: this.#deps.steering(sessionId) }),
    });

    const activeStreamId = generateSessionId();

    let settleRun!: (status: SessionEndStatus) => void;
    const settled = new Promise<SessionEndStatus>((resolve) => {
      settleRun = resolve;
    });

    let stream: Awaited<ReturnType<Agent["stream"]>>;
    let claimedTurnIds: readonly string[] = [];
    try {
      stream = await agent.stream({
        turns,
        model,
        streamId: activeStreamId,
        signal: { type: "turn" },
        ...(claims === undefined ? {} : { claims }),
        onClaimed: (turnIds) => {
          claimedTurnIds = turnIds;
        },
        onFinish: async (status, turn) => {
          // 收件箱不用在这里收尾：下一次运行开始时领全部待办项，残留的
          // step-boundary 项自然落到那一次。
          try {
            await registry.unregisterStream(activeStreamId);
            await store.clearActiveStream(sessionId, activeStreamId, status, {
              recordActivity: true,
            });
            await this.#recordOutboxItem({ status, sessionId, turn });
          } finally {
            settleRun(status);
          }
        },
      });
    } catch (error) {
      await agent.dispose();
      throw error;
    }

    // 压缩运行没有领待办项：不写这个字段，事件里就不会出现空数组。
    // 内容按真正领到的顺序取回：被取消的那一行不在 `claimedTurnIds` 里。
    const claimed = claimedTurnIds.map((id) =>
      (claims ?? []).find((claim) => claim.turn.id === id)
    );
    registry.registerStream(
      activeStreamId,
      agent,
      stream,
      claimedTurnIds.length === 0
        ? {}
        : {
            turnIds: claimedTurnIds,
            turns: claimed
              .map((claim) => claim?.turn)
              .filter((turn): turn is AgentUserTurn => turn !== undefined),
          }
    );
    // 回合开始即「最后活动」：侧边栏按它排序。
    await store.setActiveStream(sessionId, activeStreamId, {
      recordActivity: true,
    });

    return { status: "running", activeStreamId, settled };
  }

  /** 这个会话上已经有一条流在跑（压缩也算）就拒绝。 */
  #assertIdle(sessionId: string): void {
    const running = this.#deps.registry.getStreamEntryBySession(sessionId);
    if (running && !running.isDone()) {
      throw new AgentRunnerError("SESSION_BUSY", {
        sessionId,
        reason: "running",
      });
    }
  }

  /**
   * 删除一个会话。
   *
   * 先认领再清扫：行不存在或已经删过就什么都不做，返回 `removed: false`——
   * 删除是幂等的，调用方要的是「它不在了」，而这个事实已经成立。
   *
   * 忙判定只拦活跃流。真正的运行在内存里，它在跑就不能删；`wait_review` 不是
   * 运行，待审批住在会话记录里，删掉之后恢复出来还能回答（ADR 0020）。
   */
  async delete(
    sessionId: string
  ): Promise<{ removed: boolean; sessionIds: string[] }> {
    const { store, jobs } = this.#deps;

    // 先看一遍：已经删过的会话不该再去停任务、也不该白开一个事务。真正的认领
    // 在事务里（`UPDATE … WHERE deleted_at IS NULL`），两个窗口同时删时以那里
    // 的结果为准。
    const existing = await store.findSessionRow(sessionId);
    if (!existing || existing.deletedAt !== null) {
      return { removed: false, sessionIds: [] };
    }

    this.#assertIdle(sessionId);

    // 任务先停：它们还在写的时候删行，删完又会冒出新的。子会话随父一起消失，
    // 它们名下的活也不能留着，所以按整棵子树停。
    if (jobs) {
      for (const id of await store.listSessionSubtreeIds(sessionId)) {
        await jobs.disposeOwner(id);
      }
    }

    return await store.deleteSession(sessionId, new Date());
  }

  /**
   * 停掉会话正在跑的运行。
   *
   * 没有运行中的流时也清理残留的 `activeStreamId` 和子会话行，返回
   * `aborted: false`。
   */
  async stop(sessionId: string): Promise<{ aborted: boolean }> {
    const { store, registry } = this.#deps;
    const streamEntry = registry.getStreamEntryBySession(sessionId);
    if (!streamEntry || streamEntry.isDone()) {
      const session = await store.getSessionById(sessionId);
      if (session?.activeStreamId) {
        // 残留标记没有对应的运行，清它是修正而不是回合收尾。
        await store.clearActiveStream(
          sessionId,
          session.activeStreamId,
          "canceled",
          { recordActivity: false }
        );
      }
      await this.#clearChildSessions(sessionId);
      return { aborted: false };
    }

    streamEntry.agent.abort();
    await streamEntry.whenFinished();
    await store.clearActiveStream(sessionId, streamEntry.streamId, "canceled", {
      recordActivity: true,
    });
    await this.#clearChildSessions(sessionId);

    return { aborted: true };
  }

  /**
   * 按需压缩一个空闲会话。
   *
   * 选段在流创建之前完成，所以没有可压缩内容时是同步错误，调用方不需要先拿
   * streamId 再等一条失败事件。
   */
  async compact(input: CompactInput): Promise<{ activeStreamId: string }> {
    const { sessionId, model, effort, onSettled } = input;
    const { store, registry, buildAgent } = this.#deps;

    const session = await store.getSessionById(sessionId);
    if (!session) {
      throw new AgentRunnerError("SESSION_NOT_FOUND", { sessionId });
    }

    const running = registry.getStreamEntryBySession(sessionId);
    if ((running && !running.isDone()) || session.activeStreamId) {
      throw new AgentRunnerError("SESSION_BUSY", {
        sessionId,
        reason: "running",
      });
    }

    const branch = await store.getBranchTurns(sessionId);
    const turns = AgentSession.toAgentTurns(branch);
    if (
      findTurnWithoutToolResult(turns) !== null ||
      findToolApprovalRequests(turns).length > 0
    ) {
      throw new AgentRunnerError("SESSION_BUSY", {
        sessionId,
        reason: "wait_review",
      });
    }

    const agent = await buildAgent({
      sessionId,
      session: new AgentSession({ turns }),
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(session.projectId === null || session.projectId === undefined
        ? {}
        : { projectId: session.projectId }),
      streams: registry,
      ...(this.#deps.jobs === undefined ? {} : { jobs: this.#deps.jobs }),
      ...(this.#deps.steering === undefined
        ? {}
        : { steering: this.#deps.steering(sessionId) }),
    });

    const activeStreamId = generateSessionId();
    // 先落 activeStreamId 再启动流：压缩可能在流注册之前就结束，那时
    // onFinish 的 compare-and-clear 必须能找到自己这一行。
    const previousStatus =
      session.status === "running" ? "error" : session.status;
    // 压缩不是回合：它不动「最后活动」，也不改会话状态。
    await store.setActiveStream(sessionId, activeStreamId, {
      recordActivity: false,
    });

    let stream;
    try {
      stream = await agent.stream({
        turns,
        model,
        streamId: activeStreamId,
        signal: { type: "compaction", trigger: "manual" },
        onFinish: async () => {
          await registry.unregisterStream(activeStreamId);
          // 压缩只插入一条上下文标记 turn，不是模型回复：成功或失败都不该
          // 改写会话原来的状态。
          await store.clearActiveStream(
            sessionId,
            activeStreamId,
            previousStatus,
            { recordActivity: false }
          );
          onSettled?.();
        },
      });
    } catch (error) {
      await store.clearActiveStream(sessionId, activeStreamId, previousStatus, {
        recordActivity: false,
      });
      await agent.dispose();
      throw error;
    }

    registry.registerStream(activeStreamId, agent, stream);

    return { activeStreamId };
  }

  /** 从一条 branch 复制出一个自包含的新会话。 */
  async fork(input: ForkInput): Promise<{ sessionId: string }> {
    const { sessionId, messageId } = input;
    const { store } = this.#deps;

    const source = await store.getSessionById(sessionId);
    if (!source) {
      throw new AgentRunnerError("SESSION_NOT_FOUND", { sessionId });
    }

    const branchTurns = await store.getBranchTurns(source.id, {
      activeStreamId: source.activeStreamId ?? undefined,
    });
    const upToIndex = messageId
      ? branchTurns.findIndex((turn) => turn.id === messageId)
      : branchTurns.length - 1;
    if (upToIndex < 0) {
      throw new AgentRunnerError("MESSAGE_NOT_FOUND", {
        sessionId,
        ...(messageId ? { messageId } : {}),
      });
    }

    const prefix = branchTurns.slice(0, upToIndex + 1);
    if (prefix.length === 0) {
      throw new AgentRunnerError("NOTHING_TO_FORK");
    }

    const newSessionId = generateSessionId();
    // 业务 id 只在会话内唯一，所以 fork 只换会话，不换 turn/step 的 id。
    const copies: TurnWrite[] = prefix.map((turn, index) => ({
      id: turn.id,
      sessionId: newSessionId,
      type: turn.type,
      metadata: turn.metadata,
      content: turn.content,
      parentId: index === 0 ? null : turn.parentId,
      createdAt: turn.createdAt,
    }));

    await store.saveSession({
      id: newSessionId,
      title: `Fork: ${source.title}`,
      metadata: {},
      activeHeadId: copies.at(-1)?.id ?? null,
      forkedFromSessionId: source.id,
      forkedFromMessageId: messageId ?? prefix.at(-1)?.id,
      // fork 出来的会话留在源会话的项目里，否则按项目列表时会凭空少一条。
      projectId: source.projectId,
    });
    await store.saveTurns(copies);

    return { sessionId: newSessionId };
  }

  /**
   * 一次运行落定时，为它留一条发件箱记录。
   *
   * 只有跑成了、并且回合里确实有话说才记：失败、取消、等审批都不算「有事
   * 要告诉人」，空回合则是做完了但没话。写失败只告警——一条记录不该把一次
   * 已经落定的运行重新变成错误。
   */
  async #recordOutboxItem(input: {
    status: SessionEndStatus;
    sessionId: string;
    turn: AgentTurn<AgentToolSet> | undefined;
  }): Promise<void> {
    const { outbox } = this.#deps;

    if (outbox === undefined || input.status !== "done") {
      return;
    }

    if (input.turn === undefined || !hasVisibleText(input.turn)) {
      return;
    }

    try {
      await outbox.recordOutboxItem({
        sessionId: input.sessionId,
        turnId: input.turn.id,
      });
    } catch (error) {
      logger.warn("[outbox] failed to record the settled turn", error);
    }
  }

  /**
   * 把一个会话派生出的、还挂着流的子会话行清掉。
   *
   * 只动 `activeStreamId` 非空的行：已经跑完的子会话是 `done`，清它会把它从
   * "没读过"抹成 `canceled`，而它并没有被取消。
   */
  async #clearChildSessions(parentSessionId: string): Promise<void> {
    const children = await this.#deps.store.listChildSessions(parentSessionId);

    for (const child of children) {
      if (child.activeStreamId) {
        await this.#deps.store.clearActiveStream(
          child.id,
          child.activeStreamId,
          "canceled",
          { recordActivity: false }
        );
      }
    }
  }
}
