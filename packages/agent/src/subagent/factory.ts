import { logger } from "@workspace/shared/logger";

import { AgentSession } from "../agent-session";
import type { Agent } from "../agents";
import { Capabilities } from "../extensions/capabilities";
import type {
  SubagentCreateRequest,
  SubagentCreated,
  SubagentDelivery,
  SubagentListResult,
  SubagentNotifier,
  Subagents,
} from "../extensions/capabilities";
import type { AgentStore } from "../storage";
import type { SessionRecord } from "../storage/types";
import type { StreamEventRegistry } from "../stream-registry";
import type { AgentToolSet } from "../types";
import {
  buildPromptTurn,
  buildSubagent,
  readSubagentResult,
  resolveSubagentSession,
} from "./create";
import type { SubagentParent } from "./create";
import { getSubagentDefinition } from "./definitions";
import type { SubagentDefinition } from "./definitions";
import { normalizeSubagentName } from "./names";

export interface SubagentFactoryOptions {
  agent: Agent;
  store: AgentStore;
  /** The runner's registry; a child session must register in it like any other. */
  registry: StreamEventRegistry<AgentToolSet>;
  /** Where a settlement goes. Absent when nobody listens. */
  notifier?: SubagentNotifier;
  /** How many subagents one session may run at once. */
  limit?: number;
  /** The wall clock a single child run may take. Zero disables it. */
  timeoutMs?: number;
  /** The clock, so a test can move time without waiting for it. */
  now?: () => number;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/** Refused before it started: the parent already runs its limit of subagents. */
export class SubagentLimitReachedError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(
      `subagent limit reached (${limit} running); wait for one to finish or stop one`
    );
    this.name = "SubagentLimitReachedError";
    this.limit = limit;
  }
}

/** The caller named a subagent this session does not hold. */
export class SubagentNotFoundError extends Error {
  constructor(name: string) {
    super(`No subagent named "${name}".`);
    this.name = "SubagentNotFoundError";
  }
}

/**
 * The subagent type a child was started as.
 *
 * It rides on the session row's metadata: a message can arrive long after the
 * call that made the child, and building the child again has to know what it
 * was. A read-only subagent must not come back as a general one.
 */
const typeOf = (child: SessionRecord): string => {
  const { metadata } = child;

  if (metadata !== null && typeof metadata === "object") {
    const value = (metadata as { subagentType?: unknown }).subagentType;
    if (typeof value === "string") {
      return value;
    }
  }

  return "general";
};

/**
 * Messages waiting for a child's current run to settle.
 *
 * Process-wide, for the same reason the stream registry is: a child run is
 * process-local, so a message that outlives one parent turn still has to reach
 * the run it queued behind.
 */
const PENDING = new Map<string, string[]>();

/** When each live child run started, so `list-agents` can report its age. */
const STARTED = new Map<string, number>();

/**
 * Turn one parent agent into the `subagents` capability.
 *
 * A child run is started and left: the delegation answers as soon as the run is
 * registered, and the settlement arrives later as a message. That is what lets a
 * parent session do other work while a subagent works, and it is why the child's
 * lifetime is the parent session's, not the parent turn's.
 */
export function createSubagentFactory({
  agent,
  store,
  registry,
  notifier,
  limit = DEFAULT_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}: SubagentFactoryOptions): Subagents {
  const parentSessionId = agent.sessionId;

  // 父的审批函数在 start 时读：组合根在构造之后才注册，构造工厂时可能还没注册完。
  const parentOf = (toolCallId: string): SubagentParent => ({
    context: agent.context,
    tools: agent.tools,
    toolExposure: agent.toolExposure,
    toolRoute: agent.toolRoute,
    resolveModel: agent.resolveModel,
    sessionId: parentSessionId,
    toolCallId,
    toolApprovalPattern: agent.toolApprovalPattern,
    compaction: agent.extensions.capability(Capabilities.compaction),
    approvalPolicy: agent.approvalPolicy,
  });

  const children = async (): Promise<SessionRecord[]> => {
    const rows = await store.listChildSessions(parentSessionId);
    return rows.filter((child) => child.kind === "subagent");
  };

  const liveEntry = (childSessionId: string) => {
    const entry = registry.getStreamEntryBySession(childSessionId);
    return entry !== undefined && !entry.isDone() ? entry : undefined;
  };

  const resolveByName = async (name: string): Promise<SessionRecord> => {
    const row = await store.findSessionBySubagentName({
      parentSessionId,
      name: normalizeSubagentName(name),
    });

    if (row === null) {
      throw new SubagentNotFoundError(name);
    }

    return row;
  };

  const definitionOf = (child: SessionRecord): SubagentDefinition =>
    getSubagentDefinition(typeOf(child)) ?? getSubagentDefinition("general")!;

  const turnsFor = async (
    childSessionId: string,
    messages: readonly string[]
  ) => {
    const row = await store.getSessionById(childSessionId);
    const previous = await store.getBranchTurns(childSessionId, {
      activeStreamId: row?.activeStreamId ?? undefined,
    });

    return [
      ...AgentSession.toAgentTurns(previous),
      ...messages.map((message) => buildPromptTurn(message)),
    ];
  };

  const settleRun = async (
    child: { sessionId: string; name: string | null },
    definition: SubagentDefinition,
    childAgent: Agent,
    status: Parameters<Parameters<Agent["stream"]>[0]["onFinish"]>[0],
    timer: ReturnType<typeof setTimeout> | undefined
  ): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    STARTED.delete(child.sessionId);

    await registry.unregisterStream(child.sessionId);
    await store.clearActiveStream(child.sessionId, child.sessionId, status, {
      recordActivity: true,
    });

    const { report } = readSubagentResult(childAgent.session.turns);

    notifier?.deliver({
      parentSessionId,
      sessionId: child.sessionId,
      name: child.name ?? child.sessionId,
      subagentType: definition.name,
      status,
      report,
    });

    // A message that arrived while the run was going starts the next turn now,
    // so a parent never has to send the same sentence twice.
    const waiting = PENDING.get(child.sessionId);
    if (waiting !== undefined && waiting.length > 0) {
      PENDING.delete(child.sessionId);

      try {
        await runChild({
          sessionId: child.sessionId,
          name: child.name,
          definition,
          turns: await turnsFor(child.sessionId, waiting),
        });
      } catch (error) {
        logger.warn(
          "[subagent] failed to start the run behind a message",
          error
        );
      }
    }
  };

  const runChild = async (input: {
    sessionId: string;
    name: string | null;
    definition: SubagentDefinition;
    turns: Awaited<ReturnType<typeof turnsFor>>;
  }): Promise<void> => {
    const childAgent = buildSubagent(parentOf(""), {
      definition: input.definition,
      sessionId: input.sessionId,
      turns: input.turns,
      store,
    });

    // 子会话的行和父会话一样要维护状态。这一笔写在 stream 之前：子流可能
    // 在 setActiveStream 落库之前就跑完，那时 onFinish 里的 clearActiveStream
    // 会认不出自己的 streamId 而直接返回，行就永远卡在 running。
    await store.setActiveStream(input.sessionId, input.sessionId, {
      recordActivity: true,
    });

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            logger.warn(
              `[subagent] ${input.name ?? input.sessionId} hit its time limit`
            );
            childAgent.abort();
          }, timeoutMs)
        : undefined;

    const child = { sessionId: input.sessionId, name: input.name };

    try {
      const stream = await childAgent.stream({
        turns: input.turns,
        model: childAgent.context.model,
        streamId: input.sessionId,
        signal: { type: "turn" },
        onFinish: async (status) =>
          await settleRun(child, input.definition, childAgent, status, timer),
      });

      registry.registerStream(input.sessionId, childAgent, stream);
      STARTED.set(input.sessionId, now());
    } catch (error) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      await childAgent.dispose();

      try {
        await store.clearActiveStream(
          input.sessionId,
          input.sessionId,
          "error",
          {
            recordActivity: true,
          }
        );
      } catch (clearError) {
        logger.warn("[subagent] failed to clear the active stream", clearError);
      }

      throw error;
    }
  };

  return {
    async create(request: SubagentCreateRequest): Promise<SubagentCreated> {
      const siblings = await children();
      const running = siblings.filter(
        (child) => liveEntry(child.id) !== undefined
      ).length;

      if (running >= limit) {
        throw new SubagentLimitReachedError(limit);
      }

      const { sessionId, name, turns } = await resolveSubagentSession(store, {
        parentSessionId,
        toolCallId: request.toolCallId,
        description: request.description,
        prompt: request.prompt,
        botId: agent.context.botId,
        projectId: agent.context.projectId,
        approvalPolicy: agent.approvalPolicy,
        subagentType: request.definition.name,
      });

      await runChild({
        sessionId,
        name,
        definition: request.definition,
        turns,
      });

      return { name, sessionId };
    },

    async list(): Promise<SubagentListResult> {
      const rows = await children();
      const named = rows.filter((child) => child.subagentName !== null);

      const subagents = named.map((child) => {
        const live = liveEntry(child.id) !== undefined;
        const started = STARTED.get(child.id);

        return {
          name: child.subagentName!,
          sessionId: child.id,
          subagentType: typeOf(child),
          status: live ? "running" : child.status,
          ...(live && started !== undefined
            ? { runningMs: Math.max(0, now() - started) }
            : {}),
        };
      });

      return {
        running: subagents.filter((child) => child.status === "running").length,
        limit,
        subagents,
      };
    },

    async deliver({
      name,
      text,
    }: {
      name: string;
      text: string;
    }): Promise<SubagentDelivery> {
      const child = await resolveByName(name);

      if (liveEntry(child.id) !== undefined) {
        const waiting = PENDING.get(child.id) ?? [];
        waiting.push(text);
        PENDING.set(child.id, waiting);
        return "queued";
      }

      await runChild({
        sessionId: child.id,
        name: child.subagentName,
        definition: definitionOf(child),
        turns: await turnsFor(child.id, [text]),
      });

      return "started";
    },

    async stop({ name }: { name: string }): Promise<boolean> {
      const child = await resolveByName(name);
      const entry = liveEntry(child.id);

      if (entry !== undefined) {
        entry.agent.abort();
        return true;
      }

      // A run whose process is gone leaves the row marked running. Clearing it
      // is the honest answer to "stop this": it is not running, and the parent
      // should not keep seeing it as if it were.
      if (child.activeStreamId !== null) {
        await store.clearActiveStream(
          child.id,
          child.activeStreamId,
          "canceled",
          {
            recordActivity: false,
          }
        );
      }

      return false;
    },
  };
}
