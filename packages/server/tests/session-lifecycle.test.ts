import type {
  AgentCompactionTurn,
  CompactionRecord,
  InboxItem,
} from "@workspace/agent-client";
import type { TurnRecord, TurnWrite } from "@workspace/agent/storage/index";
import type {
  SessionEndStatus,
  SessionRecord,
} from "@workspace/agent/storage/types";
import { describe, expect, test } from "vitest";

import type { ConfiguredModel } from "../src/routers/settings/settings.schema";
import { SessionLifecycle } from "../src/session/lifecycle";
import type { SQLiteStore } from "../src/storage/sqlite-store";
import {
  assistantStep,
  assistantTurn,
  userTurn,
} from "./helpers/compaction-fixtures";

const asStore = (store: Partial<SQLiteStore>): SQLiteStore =>
  store as SQLiteStore;

const makeLifecycle = (store: Partial<SQLiteStore>): SessionLifecycle =>
  new SessionLifecycle({
    store: asStore(store),
    registry: {
      getStreamEntryBySession: () => {},
    } as never,
    buildAgent: () =>
      Promise.reject(new Error("buildAgent must not run in this test")),
    resolveModel: () =>
      Promise.reject(new Error("resolveModel must not run in this test")),
  });

const sessionRow = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s1",
  title: "Source",
  metadata: {},
  projectId: "p1",
  kind: "main",
  activeHeadId: null,
  activeStreamId: null,
  status: "idle",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
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
      getSessionById: () => Promise.resolve(sessionRow()),
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
  });
});

const configuredModel = (): ConfiguredModel => ({
  ref: { providerId: "test", modelId: "test-model" },
  provider: {
    id: "test",
    name: "Test",
    protocol: "openai-chat",
    baseURL: "https://example.test/v1",
    apiKey: "",
    active: true,
    models: [],
  },
  model: {
    id: "test-model",
    name: "Test",
    active: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 128_000 },
  },
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
  inboxId?: string;
  turns: { id: string }[];
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
  const make = (input: {
    agent: unknown;
    branch?: unknown[];
    /** `null` 表示这个模型引用解析不出来。 */
    model?: ConfiguredModel | null;
  }) =>
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
      resolveModel: () =>
        Promise.resolve(
          input.model === null ? undefined : (input.model ?? configuredModel())
        ),
    });

  test("认领这条待办项，并把它的回合接在 branch 后面", async () => {
    const { agent, seen } = fakeAgent();
    const lifecycle = make({
      agent,
      branch: [userTurn("turn-1", "hi"), assistantTurn("turn-2", [])],
    });

    await lifecycle.startFromInbox({
      sessionId: "s1",
      item: inboxItem("s1"),
    });

    expect({
      inboxId: seen[0]?.inboxId,
      turnIds: seen[0]?.turns.map((turn) => turn.id),
    }).toStrictEqual({
      inboxId: "item-1",
      turnIds: ["turn-1", "turn-2", "turn-new"],
    });
  });

  test("模型找不到时拒绝起跑", async () => {
    const { agent } = fakeAgent();
    const lifecycle = make({ agent, model: null });

    await expect(
      lifecycle.startFromInbox({ sessionId: "s1", item: inboxItem("s1") })
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });

  test("settled 兑现运行落定的状态", async () => {
    const { agent, seen } = fakeAgent();
    const lifecycle = make({ agent });

    const { settled } = await lifecycle.startFromInbox({
      sessionId: "s1",
      item: inboxItem("s1"),
    });

    await seen[0]?.onFinish("wait_review");

    await expect(settled).resolves.toBe("wait_review");
  });
});
