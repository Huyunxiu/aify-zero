import type { TurnRecord } from "@workspace/agent/storage/index";
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

  test("fork copies turns with fresh ids and remaps parents", async () => {
    const turns = [
      userTurn("u1", "Hi."),
      assistantTurn("a1", [assistantStep("s1", { text: "Hello." })]),
    ];
    const branch: TurnRecord[] = turns.map((turn, index) => ({
      id: turn.id,
      sessionId: "s1",
      type: turn.type,
      metadata: {},
      parentId: index === 0 ? null : (turns[0]?.id ?? null),
      status: "done",
      detail: {},
      completedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      content: turn,
    }));

    const savedSessions: unknown[] = [];
    const savedTurns: unknown[] = [];

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

    const [first, second] = savedTurns as {
      id: string;
      parentId: string | null;
      content: { id: string; content: { id: string }[] };
    }[];

    expect({
      savedSessions: savedSessions.length,
      savedTurns: savedTurns.length,
      first: first?.id,
      second: second?.id,
      parentRemapped: second?.parentId === first?.id,
      stepIdChanged: first?.content.content[0]?.id !== "u1-step",
      newSession: result.sessionId !== "s1",
    }).toStrictEqual({
      savedSessions: 1,
      savedTurns: 2,
      first: expect.any(String),
      second: expect.any(String),
      parentRemapped: true,
      stepIdChanged: true,
      newSession: true,
    });
  });
});
