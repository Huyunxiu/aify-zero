import type {
  AgentCompactionTurn,
  CompactionRecord,
} from "@workspace/agent-client";
import type { TurnRecord, TurnWrite } from "@workspace/agent/storage/index";
import type { SessionRecord } from "@workspace/agent/storage/types";
import { describe, expect, test } from "vitest";

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
    inbox: {} as never,
    registry: {
      getStreamEntryBySession: () => {},
    } as never,
    buildAgent: () =>
      Promise.reject(new Error("buildAgent must not run in this test")),
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
