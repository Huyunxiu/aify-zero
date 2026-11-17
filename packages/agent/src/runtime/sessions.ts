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
import type { ModelRef } from "@workspace/shared/model";

import { AgentSession } from "../agent-session";
import type { Agent } from "../agents";
import type { SteeringSignal } from "../inbox/steering";
import type { JobRegistry } from "../jobs/registry";
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
  inboxId?: string;
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
    const { sessionId, turns, approvals, model, effort, inboxId } = input;
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
      ...(inboxId === undefined ? {} : { inboxId }),
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
   * 从收件箱领一条待办项，开一次运行。
   *
   * 领取和写 turn 在同一个事务里完成（`inboxId` 一路传给 store）：领不到这条
   * 就抛 `InboxItemNotFoundError`，调用方据此知道它已经被别人领走了。
   */
  async startFromInbox({
    sessionId,
    item,
  }: {
    sessionId: string;
    item: InboxItem;
  }): Promise<StartedRun> {
    const { store } = this.#deps;

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
      typeof item.payload.modelEffort === "string"
        ? (item.payload.modelEffort as ModelEffort)
        : undefined;
    const projectId = item.payload.projectId ?? session.projectId ?? undefined;

    return await this.#startRun({
      sessionId,
      turns: [...AgentSession.toAgentTurns(branch), item.content],
      model: item.payload.model,
      ...(effort === undefined ? {} : { effort }),
      ...(projectId === undefined ? {} : { projectId }),
      inboxId: item.id,
      turnId: item.content.id,
      turn: item.content,
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
    inboxId?: string;
    turnId?: string;
    /** 领走的那条 user 回合的内容；随 `run.start` 一起交给读者。 */
    turn?: AgentUserTurn;
  }): Promise<StartedRun> {
    const {
      sessionId,
      turns,
      model,
      effort,
      projectId,
      inboxId,
      turnId,
      turn,
    } = input;
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
    try {
      stream = await agent.stream({
        turns,
        model,
        streamId: activeStreamId,
        signal: { type: "turn" },
        ...(inboxId === undefined ? {} : { inboxId }),
        onFinish: async (status) => {
          // 收件箱不用在这里收尾：下一次运行开始时领全部待办项，残留的
          // step-boundary 项自然落到那一次。
          try {
            await registry.unregisterStream(activeStreamId);
            await store.clearActiveStream(sessionId, activeStreamId, status);
          } finally {
            settleRun(status);
          }
        },
      });
    } catch (error) {
      await agent.dispose();
      throw error;
    }

    registry.registerStream(activeStreamId, agent, stream, {
      ...(turnId === undefined ? {} : { turnId }),
      ...(turn === undefined ? {} : { turn }),
    });
    await store.setActiveStream(sessionId, activeStreamId);

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
        await store.clearActiveStream(
          sessionId,
          session.activeStreamId,
          "canceled"
        );
      }
      await this.#clearChildSessions(sessionId);
      return { aborted: false };
    }

    streamEntry.agent.abort();
    await streamEntry.whenFinished();
    await store.clearActiveStream(sessionId, streamEntry.streamId, "canceled");
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
    await store.setActiveStream(sessionId, activeStreamId);

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
            previousStatus
          );
          onSettled?.();
        },
      });
    } catch (error) {
      await store.clearActiveStream(sessionId, activeStreamId, previousStatus);
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
          "canceled"
        );
      }
    }
  }
}
