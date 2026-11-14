import { AgentInbox, STREAM_REGISTRY } from "@workspace/agent";
import type { Agent, AgentToolSet } from "@workspace/agent";
import {
  addToolApprovalResponse,
  findToolApprovalRequests,
  findTurnWithoutToolResult,
} from "@workspace/agent-client";
import type {
  AgentTurn,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import { AgentSession } from "@workspace/agent/agent-session";
import type { TurnWrite } from "@workspace/agent/storage/index";
import { generateSessionId } from "@workspace/agent/utils/id-util";
import type { ModelEffort } from "@workspace/shared/constants";
import { logger } from "@workspace/shared/logger";

import type { ConfiguredModel } from "../routers/settings/settings.schema";
import { SQLiteStore } from "../storage/sqlite-store";
import { buildSessionAgent } from "./agent";
import type { BuildSessionAgentInput } from "./agent";

export type SessionLifecycleErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "MESSAGE_NOT_FOUND"
  | "NOTHING_TO_FORK";

/** 会话生命周期里的业务错误；路由负责把它翻译成传输层错误。 */
export class SessionLifecycleError extends Error {
  readonly code: SessionLifecycleErrorCode;
  readonly data?: Record<string, string>;

  constructor(code: SessionLifecycleErrorCode, data?: Record<string, string>) {
    super(code);
    this.name = "SessionLifecycleError";
    this.code = code;
    this.data = data;
  }
}

export type CreateSessionInput = {
  sessionId: string;
  turns: AgentTurn<AgentToolSet>[];
  approvals?: TextStreamToolApprovalResponseEvent[];
  configured: ConfiguredModel;
  effort?: ModelEffort;
  projectId?: string;
  inboxId?: string;
};

export type CreateSessionResult = {
  activeStreamId: string | null;
  awaitingToolApprovals: number;
};

export type CompactSessionInput = {
  sessionId: string;
  configured: ConfiguredModel;
};

export type ForkSessionInput = {
  sessionId: string;
  messageId?: string;
};

export interface SessionLifecycleDeps {
  store: SQLiteStore;
  inbox: AgentInbox;
  registry: typeof STREAM_REGISTRY;
  buildAgent: (input: BuildSessionAgentInput) => Promise<Agent>;
}

/**
 * 会话的生命周期：开回合、停回合、手工压缩和 fork。
 *
 * 路由只解析输入和翻译错误；这里的每个方法都能用假 store、假注册表和假
 * agent 工厂测试。
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
  async create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const { sessionId, turns, approvals, configured, effort, inboxId } = input;
    const { store, inbox, registry, buildAgent } = this.#deps;

    const mostRecentTurn = turns.at(-1);
    if (!mostRecentTurn && !approvals?.length) {
      throw new Error("no message.");
    }

    // 项目在会话行落库时固定：行已存在就沿用行上的项目，输入值只在首次
    // 落库时生效。否则刷新后还没读到会话行的发送会把目录退回默认项目。
    const previousSession = await store.getSessionById(sessionId);
    const sessionProjectId = previousSession
      ? (previousSession.projectId ?? undefined)
      : input.projectId;

    // 一条流没跑完之前不能再开一条：手工压缩也注册成流，在准备段结束后继续
    // 跑，所以占用要以注册表为准。已经结束但还没从注册表摘掉的条目（审批
    // 恢复时常见）不算占用。
    const running = registry.getStreamEntryBySession(sessionId);
    if (running && !running.isDone()) {
      throw new SessionLifecycleError("SESSION_BUSY", {
        sessionId,
        reason: "running",
      });
    }

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
        return {
          activeStreamId: null,
          awaitingToolApprovals: toolParts.length,
        };
      }
    }

    const agent = await buildAgent({
      sessionId,
      configured,
      effort,
      projectId: sessionProjectId,
      session,
      store,
    });

    const activeStreamId = generateSessionId();

    let stream: Awaited<ReturnType<Agent["stream"]>>;
    try {
      stream = await agent.stream({
        turns: originalTurns,
        model: configured.ref,
        streamId: activeStreamId,
        signal: { type: "turn" },
        inboxId,
        onFinish: async (status) => {
          // 回合结束前没被领走的 next-step 消息不能留在“下一步”上：把它们
          // 变成下一回合的排队消息，否则它们永远不会被发送。
          try {
            await inbox.promoteStale(sessionId);
          } catch (error) {
            logger.warn(
              "[session] failed to promote pending steering messages",
              error
            );
          }
          await registry.unregisterStream(activeStreamId);
          await store.clearActiveStream(sessionId, activeStreamId, status);
        },
      });
    } catch (error) {
      await agent.dispose();
      throw error;
    }

    registry.registerStream(activeStreamId, agent, stream);
    await store.setActiveStream(sessionId, activeStreamId);

    return {
      activeStreamId,
      awaitingToolApprovals: 0,
    };
  }

  /**
   * 停掉会话正在跑的回合。
   *
   * 没有运行中的流时也清理残留的 `activeStreamId` 和子会话行，返回
   * `aborted: false`——调用方要求它不跑，它确实没跑。
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
  async compact(
    input: CompactSessionInput
  ): Promise<{ activeStreamId: string }> {
    const { sessionId, configured } = input;
    const { store, inbox, registry, buildAgent } = this.#deps;

    const session = await store.getSessionById(sessionId);
    if (!session) {
      throw new SessionLifecycleError("SESSION_NOT_FOUND", { sessionId });
    }

    const running = registry.getStreamEntryBySession(sessionId);
    if ((running && !running.isDone()) || session.activeStreamId) {
      throw new SessionLifecycleError("SESSION_BUSY", {
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
      throw new SessionLifecycleError("SESSION_BUSY", {
        sessionId,
        reason: "wait_review",
      });
    }

    const agent = await buildAgent({
      sessionId,
      configured,
      projectId: session.projectId ?? undefined,
      session: new AgentSession({ turns }),
      store,
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
        model: configured.ref,
        streamId: activeStreamId,
        signal: { type: "compaction", trigger: "manual" },
        onFinish: async () => {
          try {
            await inbox.promoteStale(sessionId);
          } catch (error) {
            logger.warn(
              "[session] failed to promote pending steering messages",
              error
            );
          }
          await registry.unregisterStream(activeStreamId);
          // 压缩只插入一条上下文标记 turn，不是模型回复：成功或失败都不该
          // 改写会话原来的状态——一条完好的会话不该因为摘要失败被标成
          // error，也不该平白多出一个未读的 done。
          await store.clearActiveStream(
            sessionId,
            activeStreamId,
            previousStatus
          );
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
  async fork(input: ForkSessionInput): Promise<{ sessionId: string }> {
    const { sessionId, messageId } = input;
    const { store } = this.#deps;

    const source = await store.getSessionById(sessionId);
    if (!source) {
      throw new SessionLifecycleError("SESSION_NOT_FOUND", { sessionId });
    }

    const branchTurns = await store.getBranchTurns(source.id, {
      activeStreamId: source.activeStreamId ?? undefined,
    });
    const upToIndex = messageId
      ? branchTurns.findIndex((turn) => turn.id === messageId)
      : branchTurns.length - 1;
    if (upToIndex < 0) {
      throw new SessionLifecycleError("MESSAGE_NOT_FOUND", {
        sessionId,
        ...(messageId ? { messageId } : {}),
      });
    }

    const prefix = branchTurns.slice(0, upToIndex + 1);
    if (prefix.length === 0) {
      throw new SessionLifecycleError("NOTHING_TO_FORK");
    }

    const newSessionId = generateSessionId();
    // 业务 id 只在会话内唯一，所以 fork 只换会话，不换 turn/step 的 id。
    // 内容里的 parentId、retainedFromTurnId 都指向这些业务 id，原样复制即可；
    // 只有 branch 根不继承源会话的 parentId，避免新会话指向复制范围之外。
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

/** 默认依赖：真实的 store、inbox、注册表和装配函数；测试可以逐个覆盖。 */
export function createSessionLifecycle(
  overrides: Partial<SessionLifecycleDeps> = {}
): SessionLifecycle {
  const store = overrides.store ?? new SQLiteStore();
  return new SessionLifecycle({
    store,
    inbox: overrides.inbox ?? new AgentInbox(store),
    registry: overrides.registry ?? STREAM_REGISTRY,
    buildAgent: overrides.buildAgent ?? buildSessionAgent,
  });
}
