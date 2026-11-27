import { logger } from "@workspace/shared/logger";

import { AgentSession } from "../agent-session";
import type { Agent } from "../agents";
import { Capabilities } from "../extensions/capabilities";
import type {
  SubagentCreateRequest,
  SubagentCreated,
  SubagentHandoff,
  SubagentListResult,
  SubagentSummary,
  Subagents,
} from "../extensions/capabilities";
import type { NoticeWriter } from "../inbox/notice-writer";
import type { AgentStore } from "../storage";
import type { SessionEndStatus, SessionRecord } from "../storage/types";
import type { StreamEventRegistry } from "../stream-registry";
import type { AgentToolSet } from "../types";
import {
  buildPromptTurn,
  buildSubagent,
  readSubagentResult,
  resolveSubagentSession,
  subagentTypeOf,
} from "./create";
import type { SubagentHost } from "./create";
import { DEFAULT_SUBAGENT_TYPE, getSubagentDefinition } from "./definitions";
import type { SubagentDefinition } from "./definitions";
import { normalizeSubagentName } from "./names";
import { settledStatus, subagentNoticeRequest } from "./notice";

export interface SubagentFactoryOptions {
  agent: Agent;
  store: AgentStore;
  /** The runner's registry; a child session must register in it like any other. */
  registry: StreamEventRegistry<AgentToolSet>;
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

/** The definition a child was started as; a row written before types reads as general. */
const definitionOf = (child: SessionRecord): SubagentDefinition =>
  getSubagentDefinition(subagentTypeOf(child.metadata)) ??
  getSubagentDefinition(DEFAULT_SUBAGENT_TYPE)!;

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
  limit = DEFAULT_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}: SubagentFactoryOptions): Subagents {
  const parentSessionId = agent.sessionId;

  /**
   * The capability, read when a settlement happens rather than when the factory
   * is built: the agent is still under construction at that point.
   */
  const notices = (): NoticeWriter | undefined =>
    agent.extensions.capability(Capabilities.notices);

  // The parent's approval function is read at start time: the composition root
  // registers it after this factory is built, so reading it now would miss it.
  const hostOf = (): SubagentHost => ({
    context: agent.context,
    tools: agent.tools,
    toolExposure: agent.toolExposure,
    toolRoute: agent.toolRoute,
    resolveModel: agent.resolveModel,
    sessionId: parentSessionId,
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

  /** Refuse before a new run starts, whichever tool would start it. */
  const assertCapacity = async (): Promise<void> => {
    const rows = await children();
    const running = rows.filter(
      (child) => liveEntry(child.id) !== undefined
    ).length;

    if (running >= limit) {
      throw new SubagentLimitReachedError(limit);
    }
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
    status: SessionEndStatus,
    timer: ReturnType<typeof setTimeout> | undefined
  ): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    STARTED.delete(child.sessionId);

    // Bookkeeping comes first, and a failure there must not swallow the notice:
    // a parent waiting for a settlement is the one thing this run owes.
    try {
      await registry.unregisterStream(child.sessionId);
      await store.clearActiveStream(child.sessionId, child.sessionId, status, {
        recordActivity: true,
      });
    } catch (error) {
      logger.warn("[subagent] failed to settle the child row", error);
    }

    const { report } = readSubagentResult(childAgent.session.turns);

    const settled = settledStatus(status, report) as SessionEndStatus;

    void notices()?.write(
      subagentNoticeRequest({
        parentSessionId,
        sessionId: child.sessionId,
        name: child.name ?? child.sessionId,
        subagentType: definition.name,
        status: settled,
        report,
      })
    );

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
    const childAgent = buildSubagent(hostOf(), {
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
      await assertCapacity();

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

      // One authority decides what "running" means: the live stream entry. A row
      // that still says running without one is what a dead process leaves behind,
      // and reporting it as running would put a number on a run nobody can see.
      const subagents = named.map((child): SubagentSummary => {
        const live = liveEntry(child.id) !== undefined;
        const started = STARTED.get(child.id);

        return {
          name: child.subagentName!,
          sessionId: child.id,
          kind: "subagent",
          subagentType: subagentTypeOf(child.metadata),
          status: live
            ? "running"
            : child.status === "running"
              ? "idle"
              : child.status,
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

    async handoff({
      name,
      text,
    }: {
      name: string;
      text: string;
    }): Promise<SubagentHandoff> {
      const child = await resolveByName(name);

      if (liveEntry(child.id) !== undefined) {
        const waiting = PENDING.get(child.id) ?? [];
        waiting.push(text);
        PENDING.set(child.id, waiting);
        return "queued";
      }

      await assertCapacity();
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
