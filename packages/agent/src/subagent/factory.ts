import type { AgentTurn } from "@workspace/agent-client";
import { USER_MESSAGE_INBOX_KIND } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

import { AgentSession } from "../agent-session";
import type { Agent } from "../agents";
import { Capabilities } from "../extensions/capabilities";
import type {
  SubagentCreateRequest,
  SubagentCreated,
  SubagentHandoff,
  SubagentListResult,
  SubagentStopped,
  SubagentSummary,
  Subagents,
} from "../extensions/capabilities";
import { resolveDeliverAt } from "../inbox/delivery";
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

/** When each live child run started, so `list-agents` can report its age. */
const STARTED = new Map<string, number>();

/**
 * The one decision at a time about a session's subagents, per parent session.
 *
 * Keyed by the parent session and not by the factory, because a factory is
 * built once per parent run and a child outlives the run that started it: its
 * settlement arrives later, in a different factory, and must not pass a handoff
 * or a new delegation.
 *
 * Everything that starts, settles or stops a child runs inside this lock, so the
 * capacity count and the start it guards are one step. Counting the running
 * subagents and registering the new one are several awaits apart; without the
 * lock, two calls that arrive together would count the same number and both
 * start.
 */
const LOCKS = new Map<string, Promise<void>>();

async function withSubagentLock<T>(
  parentSessionId: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = LOCKS.get(parentSessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((_resolve) => {
    release = _resolve;
  });
  const ours = previous.then(() => gate);
  LOCKS.set(parentSessionId, ours);

  await previous;
  try {
    return await work();
  } finally {
    release();
    // Nobody is queued behind us: drop the chain instead of growing it with
    // every decision this session ever made.
    if (LOCKS.get(parentSessionId) === ours) {
      LOCKS.delete(parentSessionId);
    }
  }
}

/** The three things every decision about one child needs. */
type ChildRun = {
  sessionId: string;
  name: string | null;
  definition: SubagentDefinition;
};

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

  /** What the child's own transcript holds, before anything new is claimed. */
  const baseTurns = async (childSessionId: string) => {
    const row = await store.getSessionById(childSessionId);

    return AgentSession.toAgentTurns(
      await store.getBranchTurns(childSessionId, {
        activeStreamId: row?.activeStreamId ?? undefined,
      })
    );
  };

  /**
   * The model a child runs with: the one its definition pins, else the parent's
   * current one. A message records the same value when it waits, because the row
   * shape needs a model and this is the rule that decides it.
   */
  const modelFor = (definition: SubagentDefinition) =>
    definition.model ?? agent.context.model;

  /**
   * What is still waiting for this child, oldest first.
   *
   * Every kind, for the same reason a main session's run takes every kind: an
   * item that a run should have read must not be left for nobody.
   */
  const waiting = async (childSessionId: string) =>
    await agent.inbox.list(childSessionId);

  /** Throw away what nobody has read; a stop is the one caller. */
  const discard = async (childSessionId: string): Promise<number> => {
    let dropped = 0;
    for (const item of await waiting(childSessionId)) {
      dropped += await agent.inbox.cancel(childSessionId, item.id);
    }

    return dropped;
  };

  /**
   * Put one sentence in a child's inbox.
   *
   * The delivery boundary is the inbox's own rule, not a copy of it: a live turn
   * can take the item at its next step boundary, and anything else waits for the
   * next run.
   */
  const hold = (input: {
    child: SessionRecord;
    definition: SubagentDefinition;
    text: string;
    dedupeKey: string;
  }) => {
    const entry = liveEntry(input.child.id);

    return agent.inbox.enqueue({
      sessionId: input.child.id,
      kind: USER_MESSAGE_INBOX_KIND,
      dedupeKey: input.dedupeKey,
      deliverAt: resolveDeliverAt({
        mode: "steering",
        running: entry !== undefined,
        streamKind: entry?.agent.streamKind,
      }),
      content: buildPromptTurn(input.text),
      payload: { model: modelFor(input.definition) },
    });
  };

  const settleRun = async (
    child: ChildRun,
    childAgent: Agent,
    status: SessionEndStatus,
    timer: ReturnType<typeof setTimeout> | undefined
  ): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    STARTED.delete(child.sessionId);

    const { report } = readSubagentResult(childAgent.session.turns);

    const settled = settledStatus(status, report) as SessionEndStatus;

    // Settling and deciding who reads what next are one step: this run's slot is
    // free the moment it unregisters, and a delegation that counts in between
    // would find the room and start while this one opens the next turn.
    await withSubagentLock(parentSessionId, async () => {
      // A failure here must not swallow the notice: a parent waiting for a
      // settlement is the one thing this run owes.
      try {
        await registry.unregisterStream(child.sessionId);
        await store.clearActiveStream(
          child.sessionId,
          child.sessionId,
          status,
          {
            recordActivity: true,
          }
        );
      } catch (error) {
        logger.warn("[subagent] failed to settle the child row", error);
      }

      // The reported word folds an empty report into a failure, but these
      // decisions follow how the run actually ended: a run that finished can
      // still read what it left waiting.
      //
      // A run that did not finish drops what it never read, and the notice
      // carries the count: nothing will start this child again, so an item left
      // behind would wait for a turn nobody asked for. `wait_review` is the
      // exception — that run is parked, not over.
      const dropped =
        status === "canceled" || status === "error"
          ? await discard(child.sessionId)
          : 0;

      void notices()?.write(
        subagentNoticeRequest({
          parentSessionId,
          sessionId: child.sessionId,
          name: child.name ?? child.sessionId,
          subagentType: child.definition.name,
          status: settled,
          report,
          dropped,
          runKey: childAgent.session.turns.at(-1)?.id,
        })
      );

      // A run that ended on its own terms may open the next one, so a parent
      // never has to send the same sentence twice. A run someone stopped must
      // not: that would be the stop failing to stop.
      if (status !== "done") {
        return;
      }

      // Only the items this settlement left behind justify another turn. With
      // none, the branch still has turns, and a run would ask the model to
      // answer a history with no new message.
      const stillWaiting = await waiting(child.sessionId);
      if (stillWaiting.length === 0) {
        return;
      }

      try {
        await runChild({ child });
      } catch (error) {
        logger.warn(
          "[subagent] failed to start the run behind a waiting item",
          error
        );
      }
    });
  };

  const runChild = async (input: {
    child: ChildRun;
    /**
     * The turns this run starts from.
     *
     * A subagent that is starting comes with its first turn already in hand. A
     * run that continues one comes with none: everything it reads is claimed
     * from the inbox, deleted in the transaction that writes its turns, so no
     * message becomes two turns when the same run is retried.
     */
    turns?: AgentTurn<AgentToolSet>[];
  }): Promise<void> => {
    const { sessionId, name, definition } = input.child;
    const base = input.turns ?? (await baseTurns(sessionId));
    const items = await waiting(sessionId);
    const claims = items.map((item) => ({
      inboxId: item.id,
      turn: item.content,
    }));

    if (base.length === 0 && claims.length === 0) {
      // Nothing to open a turn with: a stop took the items before this run began.
      return;
    }

    const childAgent = buildSubagent(hostOf(), {
      definition,
      sessionId,
      turns: base,
      store,
    });

    // 子会话的行和父会话一样要维护状态。这一笔写在 stream 之前：子流可能
    // 在 setActiveStream 落库之前就跑完，那时 onFinish 里的 clearActiveStream
    // 会认不出自己的 streamId 而直接返回，行就永远卡在 running。
    await store.setActiveStream(sessionId, sessionId, {
      recordActivity: true,
    });

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            logger.warn(`[subagent] ${name ?? sessionId} hit its time limit`);
            childAgent.abort();
          }, timeoutMs)
        : undefined;

    try {
      const stream = await childAgent.stream({
        turns: base,
        ...(claims.length === 0 ? {} : { claims }),
        model: childAgent.context.model,
        streamId: sessionId,
        signal: { type: "turn" },
        onFinish: async (status) =>
          await settleRun(input.child, childAgent, status, timer),
      });

      registry.registerStream(sessionId, childAgent, stream);
      STARTED.set(sessionId, now());
    } catch (error) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      await childAgent.dispose();

      try {
        await store.clearActiveStream(sessionId, sessionId, "error", {
          recordActivity: true,
        });
      } catch (clearError) {
        logger.warn("[subagent] failed to clear the active stream", clearError);
      }

      throw error;
    }
  };

  return {
    async create(request: SubagentCreateRequest): Promise<SubagentCreated> {
      return await withSubagentLock(parentSessionId, async () => {
        // The same call replayed while its child still runs is one more sentence:
        // it adds no child and costs no second run, so the limit does not apply.
        // Read before the row exists, because a refused call must not leave one.
        const existing = await store.findSessionByParentToolCall({
          parentSessionId,
          toolCallId: request.toolCallId,
        });
        const replaysRunningChild =
          existing !== null && liveEntry(existing.id) !== undefined;

        if (!replaysRunningChild) {
          await assertCapacity();
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

        if (replaysRunningChild) {
          const row = await store.getSessionById(sessionId);
          if (row !== null) {
            await hold({
              child: row,
              definition: request.definition,
              text: request.prompt,
              dedupeKey: `create:${request.toolCallId}`,
            });
          }

          return { name, sessionId };
        }

        await runChild({
          child: {
            sessionId,
            name,
            definition: request.definition,
          },
          turns,
        });

        return { name, sessionId };
      });
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
      dedupeKey,
    }: {
      name: string;
      text: string;
      dedupeKey: string;
    }): Promise<SubagentHandoff> {
      const child = await resolveByName(name);
      const definition = definitionOf(child);

      return await withSubagentLock(parentSessionId, async () => {
        // Inside the lock this read stays true until the run starts, so the
        // boundary the item is filed under matches how it will be read.
        const live = liveEntry(child.id) !== undefined;

        // A sentence that starts a run counts against the limit; one that waits
        // for a running child does not, because it costs no second run.
        if (!live) {
          await assertCapacity();
        }

        await hold({ child, definition, text, dedupeKey });

        if (live) {
          return "queued";
        }

        await runChild({
          child: {
            sessionId: child.id,
            name: child.subagentName,
            definition,
          },
        });

        return "started";
      });
    },

    async stop({ name }: { name: string }): Promise<SubagentStopped> {
      const child = await resolveByName(name);

      // The same lock as a start: a sentence handed over and a stop must not
      // pass each other, or the stop could report a run it never reached.
      return await withSubagentLock(parentSessionId, async () => {
        // What it never read goes with the run: the turn that would have read it
        // is the one being stopped. Saying how many went is what keeps the parent
        // from believing a sentence it sent will still arrive.
        const dropped = await discard(child.id);
        const entry = liveEntry(child.id);

        if (entry !== undefined) {
          entry.agent.abort();
          return { stopped: true, dropped };
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

          // The row said a run was going, so this settlement is the first word
          // the parent gets about it. A parent that stopped it still hears how
          // it ended, or it waits for a bell that will not ring.
          void notices()?.write(
            subagentNoticeRequest({
              parentSessionId,
              sessionId: child.id,
              name: child.subagentName ?? child.id,
              subagentType: definitionOf(child).name,
              status: "canceled",
              report: "",
              dropped,
              runKey: child.activeStreamId,
            })
          );
        }

        return { stopped: false, dropped };
      });
    },
  };
}
