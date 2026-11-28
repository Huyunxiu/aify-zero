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
import type { StreamEventEntry, StreamEventRegistry } from "../stream-registry";
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

export interface SubagentSupervisorOptions {
  store: AgentStore;
  /** The runner's stream registry; child sessions register in it like any other. */
  registry: StreamEventRegistry<AgentToolSet>;
  /** Notice writer used for settlement and recovery notices. */
  notices?: NoticeWriter;
  /** How many subagents one parent session may run at once. */
  limit?: number;
  /** The wall clock a single child run may take, in milliseconds. Zero disables it. */
  timeoutMs?: number;
  /** The clock, so tests can advance or fix run age without waiting. */
  now?: () => number;
  /** Warning sink; defaults to the shared logger. */
  warn?: (message: string, error?: unknown) => void;
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

/** The three things every decision about one child needs. */
type ChildRun = {
  sessionId: string;
  name: string | null;
  definition: SubagentDefinition;
};

/**
 * Instance-scoped supervisor of subagent lifecycles for one runner.
 *
 * Owns the per-parent decision locks, child start timestamps, and silence marks
 * for children taken down with their parent, so two runner instances never share
 * state or bypass each other's lock.
 */
export class SubagentSupervisor {
  readonly #store: AgentStore;
  readonly #registry: StreamEventRegistry<AgentToolSet>;
  readonly #notices: NoticeWriter | undefined;
  readonly #limit: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #warn: (message: string, error?: unknown) => void;

  /** When each live child run started, so `list-agents` can report its age. */
  readonly #started = new Map<string, number>();

  /**
   * The one decision at a time about a session's subagents, per parent session.
   *
   * Keyed by the parent session and not by the parent `Agent` or capability
   * instance, because a child outlives the parent run that started it and its
   * settlement arrives later under the same supervisor.
   */
  readonly #locks = new Map<string, Promise<void>>();

  /**
   * Children being stopped because their parent stopped or was deleted.
   *
   * A child taken down with its parent writes no completion notice on
   * cancellation: the user asked for the stop, and the parent's next turn should
   * not open with news of it.
   */
  readonly #silenced = new Set<string>();

  constructor(options: SubagentSupervisorOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#notices = options.notices;
    this.#limit = options.limit ?? DEFAULT_LIMIT;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#warn =
      options.warn ??
      ((message, error) => {
        logger.warn(message, error);
      });
  }

  /**
   * Bind this supervisor to one parent agent as its `subagents` capability.
   *
   * A child run starts and returns immediately: the delegation answers once the
   * stream registers, and the settlement arrives later as a completion notice.
   */
  forParent(agent: Agent): Subagents {
    const parentSessionId = agent.sessionId;

    return {
      create: async (
        request: SubagentCreateRequest
      ): Promise<SubagentCreated> =>
        await this.#withLock(parentSessionId, async () => {
          const existing = await this.#store.findSessionByParentToolCall({
            parentSessionId,
            toolCallId: request.toolCallId,
          });
          const replaysRunningChild =
            existing !== null && this.#liveEntry(existing.id) !== undefined;

          if (!replaysRunningChild) {
            await this.#assertCapacity(parentSessionId);
          }

          const { sessionId, name, turns } = await resolveSubagentSession(
            this.#store,
            {
              parentSessionId,
              toolCallId: request.toolCallId,
              description: request.description,
              prompt: request.prompt,
              botId: agent.context.botId,
              projectId: agent.context.projectId,
              approvalPolicy: agent.approvalPolicy,
              subagentType: request.definition.name,
            }
          );

          if (replaysRunningChild) {
            const row = await this.#store.getSessionById(sessionId);
            if (row !== null) {
              await this.#hold(agent, {
                child: row,
                definition: request.definition,
                text: request.prompt,
                dedupeKey: `create:${request.toolCallId}`,
              });
            }

            return { name, sessionId };
          }

          await this.#runChild(agent, {
            child: {
              sessionId,
              name,
              definition: request.definition,
            },
            turns,
          });

          return { name, sessionId };
        }),

      list: async (): Promise<SubagentListResult> => {
        const rows = await this.#childrenOf(parentSessionId);
        const named = rows.filter((child) => child.subagentName !== null);

        const subagents = named.map((child): SubagentSummary => {
          const live = this.#liveEntry(child.id) !== undefined;
          const started = this.#started.get(child.id);

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
              ? { runningMs: Math.max(0, this.#now() - started) }
              : {}),
          };
        });

        return {
          running: subagents.filter((child) => child.status === "running")
            .length,
          limit: this.#limit,
          subagents,
        };
      },

      handoff: async ({
        name,
        text,
        dedupeKey,
      }: {
        name: string;
        text: string;
        dedupeKey: string;
      }): Promise<SubagentHandoff> => {
        const child = await this.#resolveByName(parentSessionId, name);
        const definition = definitionOf(child);

        return await this.#withLock(parentSessionId, async () => {
          const live = this.#liveEntry(child.id) !== undefined;

          if (!live) {
            await this.#assertCapacity(parentSessionId);
          }

          await this.#hold(agent, { child, definition, text, dedupeKey });

          if (live) {
            return "queued";
          }

          await this.#runChild(agent, {
            child: {
              sessionId: child.id,
              name: child.subagentName,
              definition,
            },
          });

          return "started";
        });
      },

      stop: async ({ name }: { name: string }): Promise<SubagentStopped> => {
        const child = await this.#resolveByName(parentSessionId, name);

        return await this.#withLock(parentSessionId, async () => {
          const dropped = await this.#store.deleteInboxItems(child.id);
          const entry = this.#liveEntry(child.id);

          if (entry !== undefined) {
            entry.agent.abort();
            return { stopped: true, dropped };
          }

          const latest = (await this.#store.getSessionById(child.id)) ?? child;
          if (latest.activeStreamId !== null) {
            await this.#clearStaleStream(latest.id, latest.activeStreamId);

            void this.#notices?.write(
              subagentNoticeRequest({
                parentSessionId,
                sessionId: latest.id,
                name: latest.subagentName ?? latest.id,
                subagentType: definitionOf(latest).name,
                status: "canceled",
                report: "",
                dropped,
                runKey: latest.activeStreamId,
              })
            );
          }

          return { stopped: false, dropped };
        });
      },
    };
  }

  /**
   * Stop every child subagent of a parent session and clear stale child stream
   * markers using a deadlock-free 3-phase protocol:
   * (a) under the per-parent lock, discard unread child inbox items, silence
   * children, and call `abort()` on live entries;
   * (b) outside the lock, await `whenFinished()` on all aborted entries so their
   * settlement handlers can acquire the lock without deadlocking;
   * (c) in `finally` under the lock, clear leftover silence marks and clear any
   * remaining stale `activeStreamId` rows whose entries are no longer live.
   */
  async stopChildren(parentSessionId: string): Promise<void> {
    const childIds: string[] = [];
    const liveEntries: StreamEventEntry<AgentToolSet>[] = [];

    try {
      await this.#withLock(parentSessionId, async () => {
        const children = await this.#store.listChildSessions(parentSessionId);

        // Discard unread items before silencing and aborting so a child that
        // finishes cleanly right at stop time cannot start a follow-up run.
        // Intentionally overrides the earlier ADR-0042 sentence per AIFY0-148.
        for (const child of children) {
          await this.#store.deleteInboxItems(child.id);
        }

        for (const child of children) {
          this.#silenced.add(child.id);
          childIds.push(child.id);

          const entry = this.#liveEntry(child.id);
          if (entry !== undefined) {
            liveEntries.push(entry);
            entry.agent.abort();
          }
        }
      });

      if (childIds.length === 0) {
        return;
      }

      await Promise.all(liveEntries.map((entry) => entry.whenFinished()));
    } finally {
      if (childIds.length > 0) {
        await this.#withLock(parentSessionId, async () => {
          for (const childId of childIds) {
            if (this.#liveEntry(childId) === undefined) {
              this.#silenced.delete(childId);
              this.#started.delete(childId);
            }
          }

          const children = await this.#store.listChildSessions(parentSessionId);
          for (const child of children) {
            if (
              child.activeStreamId &&
              this.#liveEntry(child.id) === undefined
            ) {
              await this.#clearStaleStream(child.id, child.activeStreamId);
            }
          }
        });
      }
    }
  }

  /**
   * Announce the subagent runs a previous process left behind.
   *
   * Must run after stale notices from the prior process are dropped, so the
   * recovery notices written here survive and wake the parent using its stored
   * `lastPayload`.
   */
  async reportRecovered(
    recovered: readonly { sessionId: string }[]
  ): Promise<void> {
    if (this.#notices === undefined) {
      return;
    }

    for (const outcome of recovered) {
      const row = await this.#store.getSessionById(outcome.sessionId);

      if (
        row === null ||
        row.kind !== "subagent" ||
        row.parentSessionId === null
      ) {
        continue;
      }

      const parent = await this.#store.getSessionById(row.parentSessionId);
      if (parent === null || parent.lastPayload === null) {
        this.#warn(
          `[subagent] ${row.parentSessionId} has no model to wake with; its notice is skipped`
        );
        continue;
      }

      const turns = AgentSession.toAgentTurns(
        await this.#store.getBranchTurns(row.id)
      );
      const { report, status } = readSubagentResult(turns);

      await this.#notices.write({
        ...subagentNoticeRequest({
          parentSessionId: row.parentSessionId,
          sessionId: row.id,
          name: row.subagentName ?? row.id,
          subagentType: subagentTypeOf(row.metadata),
          // A crash does not make every run a failure: one that had answered
          // and only failed to clear its marker reads as `done`. An empty
          // answer still settles as an error, matching live settlement.
          status: settledStatus(status, report),
          report,
          dropped: 0,
        }),
        payload: parent.lastPayload,
      });
    }
  }

  // Read the parent's approval pattern at child start time because the
  // composition root registers it after `Agent` constructs `subagents`.
  #hostOf(agent: Agent): SubagentHost {
    return {
      context: agent.context,
      tools: agent.tools,
      toolExposure: agent.toolExposure,
      toolRoute: agent.toolRoute,
      resolveModel: agent.resolveModel,
      sessionId: agent.sessionId,
      toolApprovalPattern: agent.toolApprovalPattern,
      compaction: agent.extensions.capability(Capabilities.compaction),
      approvalPolicy: agent.approvalPolicy,
    };
  }

  async #childrenOf(parentSessionId: string): Promise<SessionRecord[]> {
    const rows = await this.#store.listChildSessions(parentSessionId);
    return rows.filter((child) => child.kind === "subagent");
  }

  async #assertCapacity(parentSessionId: string): Promise<void> {
    const rows = await this.#childrenOf(parentSessionId);
    const running = rows.filter(
      (child) => this.#liveEntry(child.id) !== undefined
    ).length;

    if (running >= this.#limit) {
      throw new SubagentLimitReachedError(this.#limit);
    }
  }

  async #resolveByName(
    parentSessionId: string,
    name: string
  ): Promise<SessionRecord> {
    const row = await this.#store.findSessionBySubagentName({
      parentSessionId,
      name: normalizeSubagentName(name),
    });

    if (row === null) {
      throw new SubagentNotFoundError(name);
    }

    return row;
  }

  async #baseTurns(childSessionId: string) {
    const row = await this.#store.getSessionById(childSessionId);

    return AgentSession.toAgentTurns(
      await this.#store.getBranchTurns(childSessionId, {
        activeStreamId: row?.activeStreamId ?? undefined,
      })
    );
  }

  #hold(
    parentAgent: Agent,
    input: {
      child: SessionRecord;
      definition: SubagentDefinition;
      text: string;
      dedupeKey: string;
    }
  ) {
    const entry = this.#liveEntry(input.child.id);

    return this.#store.insertInboxItem({
      sessionId: input.child.id,
      kind: USER_MESSAGE_INBOX_KIND,
      dedupeKey: input.dedupeKey,
      deliverAt: resolveDeliverAt({
        mode: "steering",
        running: entry !== undefined,
        streamKind: entry?.agent.streamKind,
      }),
      content: buildPromptTurn(input.text),
      payload: {
        model: input.definition.model ?? parentAgent.context.model,
      },
    });
  }

  async #settleRun(
    parentAgent: Agent,
    child: ChildRun,
    childAgent: Agent,
    status: SessionEndStatus,
    timer: ReturnType<typeof setTimeout> | undefined
  ): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.#started.delete(child.sessionId);

    const parentSessionId = parentAgent.sessionId;
    const { report } = readSubagentResult(childAgent.session.turns);
    const settled = settledStatus(status, report) as SessionEndStatus;

    // Settling and deciding who reads what next are one locked step so a
    // concurrent delegation does not count an evicted slot before the next
    // turn opens.
    await this.#withLock(parentSessionId, async () => {
      try {
        await this.#registry.unregisterStream(child.sessionId);
        await this.#store.clearActiveStream(
          child.sessionId,
          child.sessionId,
          status,
          { recordActivity: true }
        );
      } catch (error) {
        this.#warn("[subagent] failed to settle the child row", error);
      }

      // A stopped or failed run drops unread items and reports how many went;
      // `wait_review` is parked rather than finished, and `done` opens the next
      // turn for them below.
      const dropped =
        status === "done" || status === "wait_review"
          ? 0
          : await this.#store.deleteInboxItems(child.sessionId);

      // Consume the silence mark regardless of status; a run that still finished
      // cleanly before abort took effect still reports to its parent.
      const silent =
        this.#silenced.delete(child.sessionId) && status !== "done";

      if (!silent) {
        void this.#notices?.write(
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
      }

      if (status !== "done") {
        return;
      }

      const stillWaiting = await this.#store.listInboxItems(child.sessionId);
      if (stillWaiting.length === 0) {
        return;
      }

      try {
        await this.#runChild(parentAgent, { child });
      } catch (error) {
        this.#warn(
          "[subagent] failed to start the run behind a waiting item",
          error
        );
      }
    });
  }

  async #runChild(
    parentAgent: Agent,
    input: {
      child: ChildRun;
      turns?: AgentTurn<AgentToolSet>[];
    }
  ): Promise<void> {
    const { sessionId, name, definition } = input.child;
    const base = input.turns ?? (await this.#baseTurns(sessionId));
    const items = await this.#store.listInboxItems(sessionId);
    const claims = items.map((item) => ({
      inboxId: item.id,
      turn: item.content,
    }));

    if (base.length === 0 && claims.length === 0) {
      return;
    }

    const childAgent = buildSubagent(this.#hostOf(parentAgent), {
      definition,
      sessionId,
      turns: base,
      store: this.#store,
    });

    // Record activeStreamId before starting the stream so a fast completion
    // can find and clear its own marker on finish.
    await this.#store.setActiveStream(sessionId, sessionId, {
      recordActivity: true,
    });

    let timedOut = false;
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => {
            this.#warn(`[subagent] ${name ?? sessionId} hit its time limit`);
            timedOut = true;
            childAgent.abort();
          }, this.#timeoutMs)
        : undefined;

    try {
      const stream = await childAgent.stream({
        turns: base,
        ...(claims.length === 0 ? {} : { claims }),
        model: childAgent.context.model,
        streamId: sessionId,
        signal: { type: "turn" },
        onFinish: async (status) =>
          await this.#settleRun(
            parentAgent,
            input.child,
            childAgent,
            timedOut && status === "canceled" ? "timed-out" : status,
            timer
          ),
      });

      this.#registry.registerStream(sessionId, childAgent, stream);
      this.#started.set(sessionId, this.#now());
    } catch (error) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      await childAgent.dispose();

      try {
        await this.#store.clearActiveStream(sessionId, sessionId, "error", {
          recordActivity: true,
        });
      } catch (clearError) {
        this.#warn("[subagent] failed to clear the active stream", clearError);
      }

      throw error;
    }
  }

  #clearStaleStream(sessionId: string, streamId: string): Promise<number> {
    return this.#store.clearActiveStream(sessionId, streamId, "canceled", {
      recordActivity: false,
    });
  }

  #liveEntry(
    childSessionId: string
  ): StreamEventEntry<AgentToolSet> | undefined {
    const entry = this.#registry.getStreamEntryBySession(childSessionId);
    return entry !== undefined && entry !== null && !entry.isDone()
      ? entry
      : undefined;
  }

  async #withLock<T>(
    parentSessionId: string,
    work: () => Promise<T>
  ): Promise<T> {
    const previous = this.#locks.get(parentSessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ours = previous.then(() => gate);
    this.#locks.set(parentSessionId, ours);

    await previous;
    try {
      return await work();
    } finally {
      release();
      // Drop the chain once nobody else is queued behind us.
      if (this.#locks.get(parentSessionId) === ours) {
        this.#locks.delete(parentSessionId);
      }
    }
  }
}
