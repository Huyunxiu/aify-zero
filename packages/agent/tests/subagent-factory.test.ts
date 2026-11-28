import type {
  AgentTurn,
  DeliverAt,
  EnqueueInboxInput,
  InboxItem,
} from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import type { Agent } from "../src/agents.js";
import { AgentInbox } from "../src/inbox/agent-inbox.js";
import type { NoticeWriter } from "../src/inbox/notice-writer.js";
import { SessionEventRegistry } from "../src/session-events.js";
import type { AgentStore } from "../src/storage/index.js";
import type {
  SessionEndStatus,
  SessionRecord,
  SessionWrite,
} from "../src/storage/types.js";
import { StreamEventRegistry } from "../src/stream-registry.js";
import type * as CreateModule from "../src/subagent/create.js";
import { SUBAGENT_DEFINITIONS } from "../src/subagent/definitions.js";
import {
  createSubagentFactory,
  SubagentLimitReachedError,
} from "../src/subagent/factory.js";
import { SubagentSupervisor } from "../src/subagent/supervisor.js";
import type { AgentToolSet } from "../src/types.js";
import { testModel } from "./helpers/model-target.js";

/**
 * One child run, as the supervisor started it.
 *
 * The run is fake because the subject here is what the supervisor decides, not what
 * the kernel writes: whether a run starts, what it claims, and what a stop does
 * to the words that were waiting. The turn rows are the kernel's business and
 * have their own suite.
 */
type FakeRun = {
  claims?: readonly { inboxId: string }[];
  turns: readonly AgentTurn<AgentToolSet>[];
};

type FakeChild = {
  sessionId: string;
  /** The delivery rule reads it: only a turn stream can take a steering item. */
  streamKind: "turn";
  context: { model: ReturnType<typeof testModel> };
  session: { turns: AgentTurn<AgentToolSet>[] };
  readonly runs: FakeRun[];
  /** Whether an abort settles the run, the way the kernel ends an aborted one. */
  finishOnAbort: boolean;
  abort(): void;
  dispose(): Promise<void>;
  stream(options: unknown): Promise<ReadableStream<never>>;
  /** End the run the way the kernel ends it, including its settlement. */
  finish(status: SessionEndStatus): Promise<void>;
};

const children = vi.hoisted(() => ({ made: [] as FakeChild[] }));

// The child agent is the kernel's end of the seam. The supervisor is what the tests
// read, so the agent is replaced by one whose stream the test can end.
vi.mock(import("../src/subagent/create.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof CreateModule>();
  return {
    ...actual,
    buildSubagent: (_parent: unknown, options: { sessionId: string }) => {
      const child = fakeChild(options.sessionId);
      children.made.push(child);
      return child as unknown as Agent;
    },
  };
});

/** The store the fake child claims its rows in; set by `fixture()`. */
let active: FakeStore;

/** What the supervisor told the parent; cleared by `fixture()`. */
const notices = vi.hoisted(() => ({ written: [] as string[] }));

const noticeWriter = (): NoticeWriter => ({
  write: (request) => {
    notices.written.push(request.text);
    return Promise.resolve(undefined as InboxItem | undefined);
  },
  canDeliver: () => true,
  resetBudget: () => {},
});

/**
 * A child run whose ending the test decides.
 *
 * A claim deletes its row here, the way the kernel's `saveClaimedTurns` deletes
 * it in the transaction that writes the turn.
 */
function fakeChild(sessionId: string): FakeChild {
  const runs: FakeRun[] = [];
  let settle: ((status: SessionEndStatus) => Promise<void>) | undefined;
  let close: (() => void) | undefined;

  const state = { finishOnAbort: false };

  return {
    sessionId,
    streamKind: "turn",
    context: { model: testModel() },
    session: { turns: [] },
    runs,
    get finishOnAbort() {
      return state.finishOnAbort;
    },
    set finishOnAbort(next: boolean) {
      state.finishOnAbort = next;
    },
    abort: () => {
      if (state.finishOnAbort) {
        void settle?.("canceled");
      }
    },
    dispose: () => Promise.resolve(),
    stream: (options: unknown) => {
      const input = options as {
        claims?: readonly { inboxId: string; turn: AgentTurn<AgentToolSet> }[];
        turns: readonly AgentTurn<AgentToolSet>[];
        onFinish: (status: SessionEndStatus) => Promise<void>;
      };
      runs.push({
        ...(input.claims === undefined ? {} : { claims: input.claims }),
        turns: input.turns,
      });
      for (const claim of input.claims ?? []) {
        void active.deleteInboxItems(sessionId, [claim.inboxId]);
      }

      const body = new ReadableStream<never>({
        start(controller) {
          close = () => {
            controller.close();
          };
        },
      });
      settle = async (status) => {
        await input.onFinish(status);
        close?.();
      };

      return Promise.resolve(body);
    },
    finish: async (status) => {
      await settle?.(status);
    },
  };
}

const asStore = (store: FakeStore): AgentStore =>
  store as unknown as AgentStore;

/** A parent agent with only the fields the supervisor reads; the child is faked. */
const parentAgent = (): Agent =>
  ({
    sessionId: "parent-1",
    context: { model: testModel() },
    tools: {},
    toolExposure: {},
    toolRoute: {},
    resolveModel: () => {
      throw new Error("the child build is faked; the resolver is not reached");
    },
    approvalPolicy: "edit",
    inbox: new AgentInbox(asStore(active)),
    extensions: {
      capability: () => {},
    },
  }) as unknown as Agent;

/**
 * 会话行与收件箱的最小替身。
 *
 * 领取由假子代理在开流时删行，所以这里读不删行：`listInboxItems` 必须是
 * 「还在等的东西」，否则测不到重复领取。
 */
class FakeStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly items: InboxItem[] = [];
  #seq = 0;

  getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }

  saveSession(write: SessionWrite): Promise<boolean> {
    if (this.sessions.has(write.id)) {
      return Promise.resolve(false);
    }
    // The unique index on (parent, name): two delegations in flight compute the
    // same free number, and the loser has to recompute.
    if (
      write.subagentName !== undefined &&
      write.subagentName !== null &&
      [...this.sessions.values()].some(
        (session) =>
          session.parentSessionId === write.parentSessionId &&
          session.subagentName === write.subagentName
      )
    ) {
      return Promise.resolve(false);
    }

    this.sessions.set(write.id, {
      id: write.id,
      title: write.title,
      metadata: write.metadata ?? {},
      botId: write.botId ?? "default",
      projectId: write.projectId ?? null,
      kind: write.kind ?? "main",
      activeHeadId: null,
      activeStreamId: null,
      status: "idle",
      forkedFromSessionId: null,
      forkedFromMessageId: null,
      parentSessionId: write.parentSessionId ?? null,
      parentToolCallId: write.parentToolCallId ?? null,
      subagentName: write.subagentName ?? null,
      lastPayload: null,
      approvalPolicy: write.approvalPolicy ?? "edit",
      deletedAt: null,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });

    return Promise.resolve(true);
  }

  findSessionByParentToolCall({
    parentSessionId,
    toolCallId,
  }: {
    parentSessionId: string;
    toolCallId: string;
  }): Promise<SessionRecord | null> {
    return Promise.resolve(
      [...this.sessions.values()].find(
        (session) =>
          session.parentSessionId === parentSessionId &&
          session.parentToolCallId === toolCallId
      ) ?? null
    );
  }

  findSessionBySubagentName({
    parentSessionId,
    name,
  }: {
    parentSessionId: string;
    name: string;
  }): Promise<SessionRecord | null> {
    return Promise.resolve(
      [...this.sessions.values()].find(
        (session) =>
          session.parentSessionId === parentSessionId &&
          session.subagentName === name
      ) ?? null
    );
  }

  listChildSessions(parentSessionId: string): Promise<SessionRecord[]> {
    return Promise.resolve(
      [...this.sessions.values()].filter(
        (session) => session.parentSessionId === parentSessionId
      )
    );
  }

  getBranchTurns(): Promise<never[]> {
    return Promise.resolve([]);
  }

  setActiveStream(sessionId: string, streamId: string): Promise<number> {
    const row = this.sessions.get(sessionId);
    if (row !== undefined) {
      row.activeStreamId = streamId;
      row.status = "running";
    }
    return Promise.resolve(1);
  }

  clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus
  ): Promise<number> {
    const row = this.sessions.get(sessionId);
    if (row?.activeStreamId === streamId) {
      row.activeStreamId = null;
      row.status = status;
    }
    return Promise.resolve(1);
  }

  insertInboxItem(input: EnqueueInboxInput): Promise<InboxItem> {
    const existing = this.items.find(
      (item) =>
        item.sessionId === input.sessionId && item.dedupeKey === input.dedupeKey
    );
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    this.#seq += 1;
    const item: InboxItem = {
      seq: this.#seq,
      id: `item-${String(this.#seq)}`,
      sessionId: input.sessionId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      deliverAt: input.deliverAt,
      content: input.content,
      payload: input.payload,
      createdAt: 1,
    };
    this.items.push(item);

    return Promise.resolve(item);
  }

  listInboxItems(
    sessionId: string,
    options?: { deliverAt?: DeliverAt }
  ): Promise<InboxItem[]> {
    return Promise.resolve(
      this.items.filter(
        (item) =>
          item.sessionId === sessionId &&
          (options?.deliverAt === undefined ||
            item.deliverAt === options.deliverAt)
      )
    );
  }

  deleteInboxItems(
    sessionId: string,
    ids?: readonly string[]
  ): Promise<number> {
    const kept = this.items.filter(
      (item) =>
        item.sessionId !== sessionId ||
        (ids !== undefined && !ids.includes(item.id))
    );
    const removed = this.items.length - kept.length;
    this.items.splice(0, this.items.length, ...kept);

    return Promise.resolve(removed);
  }
}

/**
 * The runner's stream registry.
 *
 * One per runner, shared by its supervisor, the way the server wires it: a
 * child's run is found by session id regardless of which parent run started it.
 */
let registry: StreamEventRegistry<AgentToolSet>;

const newRegistry = () =>
  new StreamEventRegistry<AgentToolSet>(
    new SessionEventRegistry<AgentToolSet>()
  );

const supervisorOver = (
  store: FakeStore,
  limit = 4,
  timeoutMs = 0,
  targetRegistry = registry,
  now = () => 1000
) =>
  new SubagentSupervisor({
    store: asStore(store),
    registry: targetRegistry,
    notices: noticeWriter(),
    limit,
    timeoutMs,
    now,
  });

const standaloneOver = (store: FakeStore, limit = 4, timeoutMs = 0) =>
  createSubagentFactory({
    agent: parentAgent(),
    store: asStore(store),
    registry,
    notices: noticeWriter(),
    limit,
    timeoutMs,
    now: () => 1000,
  });

/** The same rows in a new process: no live stream, a new supervisor. */
const restarted = (store: FakeStore, limit = 4) => {
  registry = newRegistry();

  return supervisorOver(store, limit).forParent(parentAgent());
};

const fixture = (limit = 4, timeoutMs = 0) => {
  active = new FakeStore();
  registry = newRegistry();
  children.made.length = 0;
  notices.written.length = 0;

  const supervisor = supervisorOver(active, limit, timeoutMs);
  return {
    store: active,
    supervisor,
    subagents: supervisor.forParent(parentAgent()),
  };
};

const definition = SUBAGENT_DEFINITIONS[0]!;

const start = (subagents: ReturnType<typeof fixture>["subagents"]) =>
  subagents.create({
    definition,
    prompt: "Find the router.",
    description: "Find the router",
    toolCallId: "call-1",
  });

describe("a message handed to a subagent", () => {
  test("waits in that subagent's inbox while it runs", async () => {
    const { store, subagents } = fixture();
    await start(subagents);

    const handoff = await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    expect(handoff).toBe("queued");
    expect(store.items).toStrictEqual([
      expect.objectContaining({
        kind: "user-message",
        dedupeKey: "call-2",
        // The kernel reads the step boundary during a live turn, so a message
        // to a running subagent can arrive before that turn ends.
        deliverAt: "step-boundary",
      }),
    ]);
    // Handing it over did not start a second run.
    expect(children.made).toHaveLength(1);
  });

  test("is read by the next turn when the current one ends cleanly", async () => {
    const { store, subagents } = fixture();
    await start(subagents);
    await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    await children.made[0]?.finish("done");

    expect(children.made).toHaveLength(2);
    expect(store.items).toHaveLength(0);
    expect(children.made[1]?.runs[0]?.claims).toStrictEqual([
      expect.objectContaining({ inboxId: "item-1" }),
    ]);
  });

  test("survives a restart and arrives with the next run", async () => {
    const { store, subagents } = fixture();
    await start(subagents);
    await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    // A new runner: no live run, a new supervisor over the same rows.
    children.made.length = 0;
    const next = restarted(store);
    const handoff = await next.handoff({
      name: "AGENT-1",
      text: "Now check the writer.",
      dedupeKey: "call-3",
    });

    expect(handoff).toBe("started");
    // Both sentences are read, in the order they were written: the one that
    // never arrived keeps its place ahead of the new one.
    expect(
      children.made[0]?.runs[0]?.claims?.map((run) => run.inboxId)
    ).toStrictEqual(["item-1", "item-2"]);
  });

  test("is dropped when the run fails, so nothing waits for a run that ended", async () => {
    const { store, subagents } = fixture();
    await start(subagents);
    await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    await children.made[0]?.finish("error");

    expect(store.items).toHaveLength(0);
    expect(children.made).toHaveLength(1);
  });

  test("stays waiting when the run is only parked for review", async () => {
    const { store, subagents } = fixture();
    await start(subagents);
    await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    await children.made[0]?.finish("wait_review");

    expect(store.items).toHaveLength(1);
  });

  test("opens a turn at once when the subagent is idle", async () => {
    const { store, subagents } = fixture();
    await start(subagents);
    await children.made[0]?.finish("done");

    const handoff = await subagents.handoff({
      name: "AGENT-1",
      text: "Now check the writer.",
      dedupeKey: "call-2",
    });

    expect(handoff).toBe("started");
    expect(children.made).toHaveLength(2);
    expect(store.items).toHaveLength(0);
    expect(children.made[1]?.runs[0]?.claims).toHaveLength(1);
  });
});

describe("the limit on running subagents", () => {
  test("starts no more than the limit when several arrive at once", async () => {
    const { subagents } = fixture(2);

    const outcomes = await Promise.allSettled(
      ["A", "B", "C"].map((letter, index) =>
        subagents.create({
          definition: SUBAGENT_DEFINITIONS[0]!,
          prompt: `Task ${letter}.`,
          description: `Task ${letter}`,
          toolCallId: `call-${String(index + 1)}`,
        })
      )
    );

    // Counting the running subagents and starting the next one have to be one
    // step: three calls that count the same number would all start.
    const failures: unknown[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        failures.push(outcome.reason);
      }
    }
    expect(children.made).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(SubagentLimitReachedError);
  });

  test("holds the limit across two capability handles from the same supervisor", async () => {
    const { supervisor } = fixture(1);
    const first = supervisor.forParent(parentAgent());
    const second = supervisor.forParent(parentAgent());

    // A capability handle is built once per parent run, so consecutive runs
    // share the supervisor's lock and registry.
    const outcomes = await Promise.allSettled([
      first.create({
        definition: SUBAGENT_DEFINITIONS[0]!,
        prompt: "Task A.",
        description: "Task A",
        toolCallId: "call-1",
      }),
      second.create({
        definition: SUBAGENT_DEFINITIONS[0]!,
        prompt: "Task B.",
        description: "Task B",
        toolCallId: "call-2",
      }),
    ]);

    const failures = outcomes.filter(
      (outcome) => outcome.status === "rejected"
    );
    expect(children.made).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  test("isolates locks, limits, timestamps, and silence across supervisor instances", async () => {
    const storeA = new FakeStore();
    const storeB = new FakeStore();
    const registryA = newRegistry();
    const registryB = newRegistry();
    let clockA = 1000;
    let clockB = 5000;
    const supervisorA = supervisorOver(storeA, 1, 0, registryA, () => clockA);
    const supervisorB = supervisorOver(storeB, 1, 0, registryB, () => clockB);

    children.made.length = 0;
    notices.written.length = 0;

    active = storeA;
    const subagentsA = supervisorA.forParent(parentAgent());
    await subagentsA.create({
      definition,
      prompt: "Task A.",
      description: "Task A",
      toolCallId: "call-a",
    });

    active = storeB;
    const subagentsB = supervisorB.forParent(parentAgent());
    await subagentsB.create({
      definition,
      prompt: "Task B.",
      description: "Task B",
      toolCallId: "call-b",
    });

    // Instance A being at capacity does not block instance B, and clock ticks stay separate.
    clockA = 2500;
    clockB = 8000;
    const listA = await subagentsA.list();
    const listB = await subagentsB.list();
    expect(listA.subagents[0]?.runningMs).toBe(1500);
    expect(listB.subagents[0]?.runningMs).toBe(3000);

    // Stopping children on supervisor A does not silence a child running in supervisor B.
    active = storeA;
    children.made[0]!.finishOnAbort = true;
    await supervisorA.stopChildren("parent-1");
    expect(notices.written).toStrictEqual([]);

    active = storeB;
    await children.made[1]?.finish("canceled");
    expect(notices.written).toHaveLength(1);
  });

  test("does not block one supervisor's parent lock while another supervisor holds the same parentSessionId lock", async () => {
    const storeA = new FakeStore();
    const storeB = new FakeStore();
    const supervisorA = supervisorOver(storeA, 4, 0, newRegistry());
    const supervisorB = supervisorOver(storeB, 4, 0, newRegistry());

    let releaseLockA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseLockA = resolve;
    });
    let enteredLockA!: () => void;
    const lockAEntered = new Promise<void>((resolve) => {
      enteredLockA = resolve;
    });

    const originalFindA = storeA.findSessionByParentToolCall.bind(storeA);
    storeA.findSessionByParentToolCall = async (input) => {
      enteredLockA();
      await gateA;
      return await originalFindA(input);
    };

    const events: string[] = [];

    active = storeA;
    const callA = supervisorA
      .forParent(parentAgent())
      .create({
        definition,
        prompt: "Task A.",
        description: "Task A",
        toolCallId: "call-a",
      })
      .then(() => {
        events.push("A");
      });

    await lockAEntered;

    // A second call on the same supervisor A must wait behind A's lock, while
    // supervisor B on the same parentSessionId proceeds without waiting.
    const queuedOnA = supervisorA
      .forParent(parentAgent())
      .create({
        definition,
        prompt: "Task A2.",
        description: "Task A2",
        toolCallId: "call-a2",
      })
      .then(() => {
        events.push("A2");
      });

    active = storeB;
    await supervisorB.forParent(parentAgent()).create({
      definition,
      prompt: "Task B.",
      description: "Task B",
      toolCallId: "call-b",
    });
    events.push("B");

    expect(events).toStrictEqual(["B"]);

    active = storeA;
    releaseLockA();
    await Promise.all([callA, queuedOnA]);
    expect(events).toStrictEqual(["B", "A", "A2"]);
  });

  test("a decision that throws does not jam the next one", async () => {
    const { store, subagents } = fixture(4);
    const saveSession = store.saveSession.bind(store);
    store.saveSession = (write) =>
      write.title === "Task A"
        ? Promise.reject(new Error("db down"))
        : saveSession(write);

    const outcomes = await Promise.allSettled([
      subagents.create({
        definition: SUBAGENT_DEFINITIONS[0]!,
        prompt: "Task A.",
        description: "Task A",
        toolCallId: "call-1",
      }),
      subagents.create({
        definition: SUBAGENT_DEFINITIONS[0]!,
        prompt: "Task B.",
        description: "Task B",
        toolCallId: "call-2",
      }),
    ]);

    const failures = outcomes.filter(
      (outcome) => outcome.status === "rejected"
    );
    expect(failures).toHaveLength(1);
    expect(children.made).toHaveLength(1);
  });

  test("refuses a new subagent while the limit is full", async () => {
    const { store, subagents } = fixture(1);
    await start(subagents);

    await expect(
      subagents.create({
        definition: SUBAGENT_DEFINITIONS[0]!,
        prompt: "Task B.",
        description: "Task B",
        toolCallId: "call-2",
      })
    ).rejects.toBeInstanceOf(SubagentLimitReachedError);

    // A refused call leaves no row behind: a child that never ran would show up
    // as idle and could be messaged later.
    const rows = [...store.sessions.values()].filter(
      (session) => session.kind === "subagent"
    );
    expect(rows).toHaveLength(1);
  });

  test("takes a replayed create as one more sentence, not a second run", async () => {
    const { store, subagents } = fixture(1);
    await start(subagents);

    // The same call again is "say one more thing to that child" (story 19). It
    // adds no child, so the full limit must not refuse it, and the running child
    // takes the sentence instead of a second run opening.
    const replay = await subagents.create({
      definition: SUBAGENT_DEFINITIONS[0]!,
      prompt: "Also check the parser.",
      description: "Find the router",
      toolCallId: "call-1",
    });

    expect(replay.name).toBe("AGENT-1");
    expect(children.made).toHaveLength(1);
    expect(store.items).toStrictEqual([
      expect.objectContaining({ deliverAt: "step-boundary" }),
    ]);
  });

  test("still hands a sentence to a running subagent when the limit is full", async () => {
    const { subagents } = fixture(1);
    await start(subagents);

    // A sentence that waits costs no second run, so the limit does not apply.
    await expect(
      subagents.handoff({
        name: "AGENT-1",
        text: "Also check the parser.",
        dedupeKey: "call-2",
      })
    ).resolves.toBe("queued");
  });

  test("keeps one run after a settlement opens the next turn", async () => {
    const { subagents } = fixture(1);
    await start(subagents);
    await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    await children.made[0]?.finish("done");

    const listed = await subagents.list();
    expect(children.made).toHaveLength(2);
    expect(listed.running).toBe(1);
  });
});

describe("the time limit on a run", () => {
  test("settles a run the clock stopped as timed-out, not canceled", async () => {
    const { store, subagents } = fixture(4, 50);
    await start(subagents);

    // The kernel ends an aborted run as canceled. Only the supervisor knows
    // that the clock aborted it, so it names the cause in the settlement.
    children.made[0]!.finishOnAbort = true;

    await vi.waitFor(() => {
      expect(notices.written).toHaveLength(1);
    });

    expect(notices.written[0]).toContain("settled: timed-out");
    expect(store.sessions.get(children.made[0]!.sessionId)?.status).toBe(
      "timed-out"
    );
  });
});

describe("stopping a subagent", () => {
  test("drops the words it never read, and says how many", async () => {
    const { store, subagents } = fixture();
    await start(subagents);
    await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    const stopped = await subagents.stop({ name: "AGENT-1" });

    expect(stopped).toStrictEqual({ stopped: true, dropped: 1 });
    expect(store.items).toHaveLength(0);
  });

  test("does not start the turn those words asked for", async () => {
    const { subagents } = fixture();
    await start(subagents);
    await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    await subagents.stop({ name: "AGENT-1" });
    await children.made[0]?.finish("canceled");

    expect(children.made).toHaveLength(1);
  });

  test("settles a run it found only as a stale row, so the parent hears the ending", async () => {
    // A process that died leaves the row marked running with no stream to stop.
    const store = new FakeStore();
    active = store;
    notices.written.length = 0;
    await store.saveSession({
      id: "child-1",
      title: "Find the router",
      kind: "subagent",
      parentSessionId: "parent-1",
      parentToolCallId: "call-1",
      subagentName: "AGENT-1",
      metadata: { subagentType: "general" },
    });
    const row = store.sessions.get("child-1");
    if (row === undefined) {
      throw new Error("the seeded row should exist");
    }
    row.activeStreamId = "gone";
    row.status = "running";

    const stopped = await standaloneOver(store).stop({ name: "AGENT-1" });

    expect(stopped).toStrictEqual({ stopped: false, dropped: 0 });
    expect(notices.written.at(-1)).toContain("settled: canceled");
  });

  test("drops nothing when nothing was waiting", async () => {
    const { subagents } = fixture();
    await start(subagents);

    await expect(subagents.stop({ name: "AGENT-1" })).resolves.toStrictEqual({
      stopped: true,
      dropped: 0,
    });
  });
});

describe("a child stopped with its parent", () => {
  test("silences canceled children, discards unread inbox items, and finishes without deadlocking", async () => {
    const { store, supervisor, subagents } = fixture();
    await start(subagents);
    await subagents.handoff({
      name: "AGENT-1",
      text: "Also check the parser.",
      dedupeKey: "call-2",
    });

    const [child] = children.made;
    if (child === undefined) {
      throw new Error("the create call should have started a child");
    }
    child.finishOnAbort = true;

    await supervisor.stopChildren("parent-1");

    expect(notices.written).toStrictEqual([]);
    expect(store.items).toStrictEqual([]);
    expect(store.sessions.get(child.sessionId)?.activeStreamId).toBeNull();
    expect(store.sessions.get(child.sessionId)?.status).toBe("canceled");
  });

  test("still reports a run that finished cleanly while stopChildren runs", async () => {
    const { supervisor, subagents } = fixture();
    await start(subagents);
    const [child] = children.made;
    if (child === undefined) {
      throw new Error("the create call should have started a child");
    }

    child.session.turns.push({
      id: "turn-done",
      type: "assistant",
      createdAt: 1,
      status: "done",
      content: [
        {
          id: "step-done",
          type: "assistant",
          createdAt: 1,
          status: "done",
          model: "test-model",
          content: [
            { type: "text", text: "All done.", state: "done", createdAt: 1 },
          ],
        },
      ],
    } as AgentTurn<AgentToolSet>);
    child.abort = () => {
      void child.finish("done");
    };

    await supervisor.stopChildren("parent-1");

    expect(notices.written).toHaveLength(1);
    expect(notices.written[0]).toContain("settled: done");
    expect(notices.written[0]).toContain("All done.");
  });

  test("clears leftover silence marks when a child was idle during stopChildren", async () => {
    const { supervisor, subagents } = fixture();
    await start(subagents);
    await children.made[0]?.finish("done");
    notices.written.length = 0;

    // Stopping children while idle adds and clears silence marks in `finally`.
    await supervisor.stopChildren("parent-1");

    // A later run on the same child that cancels must still write its notice.
    await subagents.handoff({
      name: "AGENT-1",
      text: "Run again.",
      dedupeKey: "call-2",
    });
    await children.made[1]?.finish("canceled");

    expect(notices.written).toHaveLength(1);
    expect(notices.written[0]).toContain("settled: canceled");
  });

  test("clears stale activeStreamId rows with no live stream entry", async () => {
    const { store, supervisor } = fixture();
    await store.saveSession({
      id: "stale-child",
      title: "Stale child",
      kind: "subagent",
      parentSessionId: "parent-1",
      parentToolCallId: "call-stale",
      subagentName: "AGENT-1",
      metadata: { subagentType: "general" },
    });
    const row = store.sessions.get("stale-child")!;
    row.activeStreamId = "dead-stream";
    row.status = "running";

    await supervisor.stopChildren("parent-1");

    expect(row.activeStreamId).toBeNull();
    expect(row.status).toBe("canceled");
    expect(notices.written).toStrictEqual([]);
  });

  test("keeps a still-live child's activeStreamId and silence mark if stopChildren fails mid-phase", async () => {
    const { store, supervisor, subagents } = fixture();
    await start(subagents);
    await subagents.create({
      definition,
      prompt: "Second task.",
      description: "Second task",
      toolCallId: "call-2",
    });

    const first = children.made[0]!;
    const second = children.made[1]!;
    second.abort = () => {
      throw new Error("abort failed");
    };

    await expect(supervisor.stopChildren("parent-1")).rejects.toThrow(
      "abort failed"
    );

    // Both children are still live after the partial abort failure: Phase (c)
    // must not wipe their running activeStreamId or drop their silence marks.
    expect(store.sessions.get(first.sessionId)?.activeStreamId).toBe(
      first.sessionId
    );
    expect(store.sessions.get(second.sessionId)?.activeStreamId).toBe(
      second.sessionId
    );

    await first.finish("canceled");
    expect(notices.written).toStrictEqual([]);
  });
});
