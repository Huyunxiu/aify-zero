import type {
  AgentCompactionTurn,
  CompactionRecord,
  InboxItem,
} from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { SessionLifecycle } from "../../src/runtime/sessions";
import type { BuildAgentInput } from "../../src/runtime/types";
import type { AgentStore, TurnRecord, TurnWrite } from "../../src/storage";
import type { SessionEndStatus, SessionRecord } from "../../src/storage/types";
import {
  assistantStep,
  assistantTurn,
  userTurn,
} from "./helpers/compaction-fixtures";

const asStore = (store: Partial<AgentStore>): AgentStore => store as AgentStore;

const makeLifecycle = (
  store: Partial<AgentStore>,
  entries: Record<string, unknown> = {}
): SessionLifecycle =>
  new SessionLifecycle({
    store: asStore(store),
    registry: {
      getStreamEntryBySession: (sessionId: string) => entries[sessionId],
    } as never,
    buildAgent: () =>
      Promise.reject(new Error("buildAgent must not run in this test")),
  });

const sessionRow = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s1",
  title: "Source",
  metadata: {},
  botId: "default",
  projectId: "p1",
  kind: "main",
  activeHeadId: null,
  activeStreamId: null,
  status: "idle",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  subagentName: null,
  lastPayload: null,
  approvalPolicy: "edit",
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

describe(SessionLifecycle, () => {
  test("stop clears a stale marker and child streams", async () => {
    const cleared: { sessionId: string; streamId: string; status: string }[] =
      [];

    const lifecycle = makeLifecycle({
      getSessionById: () =>
        Promise.resolve(sessionRow({ activeStreamId: "s1" })),
      clearActiveStream: (sessionId, streamId, status) => {
        cleared.push({ sessionId, streamId, status });
        return Promise.resolve(1);
      },
      listChildSessions: () =>
        Promise.resolve([sessionRow({ id: "c1", activeStreamId: "cs1" })]),
    });

    const result = await lifecycle.stop("s1");

    expect(result).toStrictEqual({ aborted: false });
    expect(cleared).toStrictEqual([
      { sessionId: "s1", streamId: "s1", status: "canceled" },
      { sessionId: "c1", streamId: "cs1", status: "canceled" },
    ]);
  });

  test("stop aborts a child that is still running before it clears the row", async () => {
    // A child can outlive the run that started it, and it holds that run's
    // abort scope, not the session's. Stopping the session later reaches it
    // only here.
    const order: string[] = [];
    let finished!: () => void;
    const childDone = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const cleared: { sessionId: string; status: string }[] = [];

    const lifecycle = makeLifecycle(
      {
        getSessionById: () => Promise.resolve(sessionRow()),
        clearActiveStream: (sessionId, _streamId, status) => {
          cleared.push({ sessionId, status });
          return Promise.resolve(1);
        },
        listChildSessions: () =>
          Promise.resolve([sessionRow({ id: "c1", activeStreamId: "cs1" })]),
      },
      {
        c1: {
          isDone: () => false,
          agent: {
            abort: () => {
              order.push("abort");
              finished();
            },
          },
          whenFinished: () => {
            order.push("wait");
            return childDone;
          },
        },
      }
    );

    await lifecycle.stop("s1");

    expect(order).toStrictEqual(["abort", "wait"]);
    expect(cleared).toStrictEqual([{ sessionId: "c1", status: "canceled" }]);
  });

  test("stop does not abort a child that already finished", async () => {
    let aborted = false;

    const lifecycle = makeLifecycle(
      {
        getSessionById: () => Promise.resolve(sessionRow()),
        clearActiveStream: () => Promise.resolve(1),
        listChildSessions: () =>
          Promise.resolve([sessionRow({ id: "c1", activeStreamId: "cs1" })]),
      },
      {
        c1: {
          isDone: () => true,
          agent: {
            abort: () => {
              aborted = true;
            },
          },
          whenFinished: () => Promise.resolve(),
        },
      }
    );

    await lifecycle.stop("s1");

    expect(aborted).toBeFalsy();
  });

  test("fork copies turns without rewriting ids", async () => {
    const compactionRecord: CompactionRecord = {
      version: 1,
      id: "c1-part",
      trigger: "manual",
      summary: "summary",
      tokensBefore: 10,
      tokensAfter: 5,
      shadowedTokens: 5,
      shadowedTurns: 1,
      shadowedSteps: 1,
      model: "test-model",
      retainedFromTurnId: "u1",
      createdAt: 2,
    };
    const compactionTurn: AgentCompactionTurn = {
      id: "c1",
      type: "compaction",
      createdAt: 2,
      status: "done",
      content: [
        {
          id: "c1-step",
          type: "compaction",
          createdAt: 2,
          status: "done",
          model: "test-model",
          content: [
            {
              type: "compaction",
              id: "c1-part",
              state: "done",
              createdAt: 2,
              record: compactionRecord,
            },
          ],
        },
      ],
    };

    const turns = [
      userTurn("u1", "Hi."),
      assistantTurn("a1", [assistantStep("s1", { text: "Hello." })]),
      compactionTurn,
    ];
    const branch: TurnRecord[] = turns.map((turn, index) => ({
      id: turn.id,
      sessionId: "s1",
      type: turn.type,
      metadata: {},
      parentId: index === 0 ? null : (turns[index - 1]?.id ?? null),
      status: "done",
      detail: {},
      completedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      content: turn,
    }));

    const savedSessions: unknown[] = [];
    const savedTurns: TurnWrite[] = [];

    const lifecycle = makeLifecycle({
      getSessionById: () =>
        Promise.resolve(
          sessionRow({ approvalPolicy: "edit", botId: "b-custom" })
        ),
      getBranchTurns: () => Promise.resolve(branch),
      saveSession: (session) => {
        savedSessions.push(session);
        return Promise.resolve(true);
      },
      saveTurns: (writes) => {
        savedTurns.push(...writes);
        return Promise.resolve(writes.length);
      },
    });

    const result = await lifecycle.fork({ sessionId: "s1" });

    // 压缩记录的切点也原样保留：它指向同一条被复制过来的 turn。
    const compactionStep = savedTurns[2]?.content.content[0];
    const compactionPart =
      compactionStep?.type === "compaction"
        ? compactionStep.content[0]
        : undefined;

    expect({
      savedSessions: savedSessions.length,
      turnIds: savedTurns.map((turn) => turn.id),
      parentIds: savedTurns.map((turn) => turn.parentId),
      allInNewSession: savedTurns.every(
        (turn) => turn.sessionId === result.sessionId
      ),
      userStepId: savedTurns[0]?.content.content[0]?.id,
      assistantStepId: savedTurns[1]?.content.content[0]?.id,
      retainedFromTurnId: compactionPart?.record?.retainedFromTurnId,
    }).toStrictEqual({
      savedSessions: 1,
      turnIds: ["u1", "a1", "c1"],
      parentIds: [null, "u1", "a1"],
      allInNewSession: true,
      userStepId: "u1-step",
      assistantStepId: "s1",
      retainedFromTurnId: "u1",
    });
    // A branch continues the same posture: the source session stores Edit, and the fork row stores Edit too.
    expect(savedSessions[0]).toMatchObject({ approvalPolicy: "edit" });
    expect(savedSessions[0]).toMatchObject({ botId: "b-custom" });
  });
});

const inboxItem = (sessionId: string): InboxItem => ({
  seq: 0,
  id: "item-1",
  sessionId,
  kind: "user-message",
  dedupeKey: "dedupe-1",
  deliverAt: "run-boundary",
  content: userTurn("turn-new", "again"),
  payload: { model: { providerId: "test", modelId: "test-model" } },
  createdAt: 1,
});

type StreamOptions = {
  claims?: readonly { inboxId: string; turn: { id: string } }[];
  model: { providerId: string; modelId: string };
  turns: { id: string }[];
  onClaimed?: (turnIds: readonly string[]) => void;
  onFinish: (status: SessionEndStatus) => Promise<void>;
};

/** 只会记录被怎么调用的 agent 替身。 */
const fakeAgent = () => {
  const seen: StreamOptions[] = [];

  return {
    seen,
    agent: {
      stream: (options: StreamOptions) => {
        seen.push(options);
        return Promise.resolve(new ReadableStream());
      },
      dispose: () => Promise.resolve(),
    },
  };
};

describe("SessionLifecycle.startFromInbox", () => {
  const make = (input: { agent: unknown; branch?: unknown[] }) =>
    new SessionLifecycle({
      store: asStore({
        getSessionById: () => Promise.resolve(sessionRow()),
        getBranchTurns: () =>
          Promise.resolve(
            (input.branch ?? []).map((content) => ({ content })) as never
          ),
        setActiveStream: () => Promise.resolve(1),
        clearActiveStream: () => Promise.resolve(1),
      }),
      registry: {
        getStreamEntryBySession: () => null,
        registerStream: () => {},
        unregisterStream: () => Promise.resolve(true),
      } as never,
      buildAgent: () => Promise.resolve(input.agent as never),
    });

  test("认领这条待办项，并把它的回合接在 branch 后面", async () => {
    const { agent, seen } = fakeAgent();
    const lifecycle = make({
      agent,
      branch: [userTurn("turn-1", "hi"), assistantTurn("turn-2", [])],
    });

    await lifecycle.startFromInbox({
      sessionId: "s1",
      items: [inboxItem("s1")],
    });

    expect({
      claims: seen[0]?.claims?.map((claim) => [claim.inboxId, claim.turn.id]),
      turnIds: seen[0]?.turns.map((turn) => turn.id),
    }).toStrictEqual({
      claims: [["item-1", "turn-new"]],
      turnIds: ["turn-1", "turn-2"],
    });
  });

  test("一次运行领走全部待办项，模型取最后一条", async () => {
    const { agent, seen } = fakeAgent();
    const lifecycle = make({
      agent,
      branch: [userTurn("turn-1", "hi"), assistantTurn("turn-2", [])],
    });

    await lifecycle.startFromInbox({
      sessionId: "s1",
      items: [
        inboxItem("s1"),
        {
          ...inboxItem("s1"),
          id: "item-2",
          seq: 1,
          content: userTurn("turn-new-2", "and this"),
          payload: { model: { providerId: "test", modelId: "second" } },
        },
      ],
    });

    expect(seen[0]?.claims?.map((claim) => claim.inboxId)).toStrictEqual([
      "item-1",
      "item-2",
    ]);
    expect(seen[0]?.model).toStrictEqual({
      providerId: "test",
      modelId: "second",
    });
    // 待办项不进 `turns`：它们由运行在领取之后接进历史。
    expect(seen[0]?.turns.map((turn) => turn.id)).toStrictEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  test("把领取到的回合 id 和内容交给事件通道", async () => {
    const registered: {
      turnIds?: readonly string[];
      turns?: readonly { id: string }[];
    }[] = [];

    const lifecycle = new SessionLifecycle({
      store: asStore({
        getSessionById: () => Promise.resolve(sessionRow()),
        getBranchTurns: () => Promise.resolve([]),
        setActiveStream: () => Promise.resolve(1),
        clearActiveStream: () => Promise.resolve(1),
      }),
      registry: {
        getStreamEntryBySession: () => null,
        registerStream: (
          _streamId: string,
          _agent: unknown,
          _stream: unknown,
          options?: {
            turnIds?: readonly string[];
            turns?: readonly { id: string }[];
          }
        ) => {
          registered.push(options ?? {});
        },
        unregisterStream: () => Promise.resolve(true),
      } as never,
      buildAgent: () =>
        Promise.resolve({
          stream: (options: StreamOptions) => {
            options.onClaimed?.(["turn-new"]);
            return Promise.resolve(new ReadableStream());
          },
          dispose: () => Promise.resolve(),
        } as never),
    });

    await lifecycle.startFromInbox({
      sessionId: "s1",
      items: [inboxItem("s1")],
    });

    // 身份与内容一起过去：读者可能既没发过这条回合，也没在收件箱里见过它。
    expect(registered).toStrictEqual([
      { turnIds: ["turn-new"], turns: [inboxItem("s1").content] },
    ]);
  });

  test("settled 兑现运行落定的状态", async () => {
    const { agent, seen } = fakeAgent();
    const lifecycle = make({ agent });

    const { settled } = await lifecycle.startFromInbox({
      sessionId: "s1",
      items: [inboxItem("s1")],
    });

    await seen[0]?.onFinish("wait_review");

    await expect(settled).resolves.toBe("wait_review");
  });
});

describe("SessionLifecycle startFromInbox guards", () => {
  test("子会话不能从收件箱起跑", async () => {
    const lifecycle = new SessionLifecycle({
      store: asStore({
        getSessionById: () => Promise.resolve(sessionRow({ kind: "subagent" })),
      }),
      registry: {
        getStreamEntryBySession: () => {},
      } as never,
      buildAgent: () => Promise.reject(new Error("must not build")),
    });

    await expect(
      lifecycle.startFromInbox({ sessionId: "s1", items: [inboxItem("s1")] })
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      code: "SESSION_NOT_RUNNABLE",
    });
  });
});

describe("approval policy on SessionLifecycle", () => {
  const lifecycleFor = (seen: BuildAgentInput[]) => {
    const { agent } = fakeAgent();

    return new SessionLifecycle({
      store: asStore({
        getSessionById: () =>
          Promise.resolve(
            sessionRow({ approvalPolicy: "edit", botId: "b-custom" })
          ),
        getBranchTurns: () => Promise.resolve([]),
        setActiveStream: () => Promise.resolve(1),
        clearActiveStream: () => Promise.resolve(1),
      }),
      registry: {
        getStreamEntryBySession: () => null,
        registerStream: () => {},
        unregisterStream: () => Promise.resolve(true),
      } as never,
      buildAgent: (input) => {
        seen.push(input);
        return Promise.resolve(agent as never);
      },
    });
  };

  test("a timer-driven run uses the stored policy", async () => {
    const seen: BuildAgentInput[] = [];

    await lifecycleFor(seen).startFromInbox({
      sessionId: "s1",
      items: [{ ...inboxItem("s1"), kind: "timer" }],
    });

    expect(seen[0]?.approvalPolicy).toBe("edit");
  });

  test("a completion notice uses the stored policy too", async () => {
    const seen: BuildAgentInput[] = [];

    await lifecycleFor(seen).startFromInbox({
      sessionId: "s1",
      items: [{ ...inboxItem("s1"), kind: "job-notice" }],
    });

    expect(seen[0]?.approvalPolicy).toBe("edit");
  });

  test("a user message keeps the stored policy and botId", async () => {
    const seen: BuildAgentInput[] = [];

    await lifecycleFor(seen).startFromInbox({
      sessionId: "s1",
      items: [inboxItem("s1")],
    });

    expect(seen[0]?.approvalPolicy).toBe("edit");
    expect(seen[0]?.botId).toBe("b-custom");
  });
});
