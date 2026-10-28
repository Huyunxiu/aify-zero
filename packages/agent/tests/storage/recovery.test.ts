import type { AgentTurn } from "@workspace/agent-client";
import type { SessionModel } from "@workspace/db";
import { describe, expect, test } from "vitest";

import type { SessionEndStatus } from "../../src/storage/index.js";
import {
  INTERRUPTED_TURN_ERROR,
  recoverInterruptedRuns,
} from "../../src/storage/recovery.js";
import type { RecoveryStore } from "../../src/storage/recovery.js";
import type { TurnRecord } from "../../src/storage/turn-record.js";
import type { AgentToolSet } from "../../src/types.js";
import {
  assistantStep,
  assistantTurn,
  compactionTurn,
  userTurn,
} from "../compaction/fixtures.js";

const session = (overrides: Partial<SessionModel> = {}): SessionModel => ({
  id: "session-1",
  title: "test",
  metadata: {},
  projectId: null,
  kind: "main",
  activeHeadId: "a1",
  activeStreamId: "stream-1",
  status: "running",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const record = (
  content: AgentTurn<AgentToolSet>,
  overrides: Partial<TurnRecord> = {}
): TurnRecord => ({
  id: content.id,
  sessionId: "session-1",
  type: content.type,
  metadata: {},
  parentId: null,
  status: content.status,
  detail: null,
  completedAt:
    content.completedAt === undefined ? null : new Date(content.completedAt),
  createdAt: new Date(content.createdAt),
  updatedAt: new Date(content.createdAt),
  content,
  ...overrides,
});

const streamingTurn = (): AgentTurn<AgentToolSet> => {
  const step = {
    ...assistantStep("s1", { text: "half" }),
    completedAt: 500,
  };
  return {
    ...assistantTurn("a1", [step]),
    status: "streaming",
  } as AgentTurn<AgentToolSet>;
};

class FakeStore implements RecoveryStore {
  readonly updates: { id: string; turn: AgentTurn }[] = [];
  readonly clears: {
    sessionId: string;
    streamId: string;
    status: SessionEndStatus;
  }[] = [];
  readonly promoted: string[] = [];

  private readonly options: {
    sessions: SessionModel[];
    branch: TurnRecord[];
    failUpdate?: boolean;
    failPromote?: boolean;
  };

  constructor(options: {
    sessions: SessionModel[];
    branch: TurnRecord[];
    failUpdate?: boolean;
    failPromote?: boolean;
  }) {
    this.options = options;
  }

  listInterruptedSessions(): Promise<SessionModel[]> {
    return Promise.resolve(this.options.sessions);
  }

  getBranchTurns(): Promise<TurnRecord[]> {
    return Promise.resolve(this.options.branch);
  }

  updateTurnHeader(id: string, turn: AgentTurn): Promise<number> {
    if (this.options.failUpdate) {
      return Promise.reject(new Error("db down"));
    }
    this.updates.push({ id, turn });
    return Promise.resolve(1);
  }

  clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus
  ): Promise<number> {
    this.clears.push({ sessionId, streamId, status });
    return Promise.resolve(1);
  }

  promoteStaleInboxMessages(sessionId: string): Promise<number> {
    if (this.options.failPromote) {
      return Promise.reject(new Error("inbox down"));
    }
    this.promoted.push(sessionId);
    return Promise.resolve(0);
  }
}

describe(recoverInterruptedRuns, () => {
  test("settles a streaming turn and clears the marker", async () => {
    const store = new FakeStore({
      sessions: [session()],
      branch: [record(streamingTurn())],
    });

    const outcomes = await recoverInterruptedRuns(store);

    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]?.turn).toMatchObject({
      status: "error",
      error: INTERRUPTED_TURN_ERROR,
      completedAt: 500,
    });
    expect(store.clears).toStrictEqual([
      { sessionId: "session-1", streamId: "stream-1", status: "error" },
    ]);
    // 上个进程没领走的 next-step 消息要提升为下一回合。
    expect(store.promoted).toStrictEqual(["session-1"]);
    expect(outcomes).toStrictEqual([
      { sessionId: "session-1", settledTurnId: "a1" },
    ]);
  });

  test("clears the marker without touching a finished turn", async () => {
    const store = new FakeStore({
      sessions: [session()],
      branch: [record(assistantTurn("a1", [assistantStep("s1")]))],
    });

    await recoverInterruptedRuns(store);

    expect(store.updates).toHaveLength(0);
    expect(store.clears).toStrictEqual([
      { sessionId: "session-1", streamId: "stream-1", status: "done" },
    ]);
  });

  test("marks a user turn as an interrupted run", async () => {
    const store = new FakeStore({
      sessions: [session({ activeHeadId: "u1" })],
      branch: [record(userTurn("u1", "hi"))],
    });

    await recoverInterruptedRuns(store);

    expect(store.clears).toStrictEqual([
      { sessionId: "session-1", streamId: "stream-1", status: "error" },
    ]);
  });

  test("leaves a compaction head idle", async () => {
    const turn = compactionTurn();
    const store = new FakeStore({
      sessions: [session({ activeHeadId: turn.id })],
      branch: [record(turn)],
    });

    await recoverInterruptedRuns(store);

    expect(store.clears).toStrictEqual([
      { sessionId: "session-1", streamId: "stream-1", status: "idle" },
    ]);
  });

  test("keeps the marker when the header write fails", async () => {
    const store = new FakeStore({
      sessions: [session()],
      branch: [record(streamingTurn())],
      failUpdate: true,
    });

    await expect(recoverInterruptedRuns(store)).resolves.toStrictEqual([]);
    expect(store.clears).toHaveLength(0);
  });

  test("does nothing when no session is interrupted", async () => {
    const store = new FakeStore({ sessions: [], branch: [] });

    await expect(recoverInterruptedRuns(store)).resolves.toStrictEqual([]);
    expect(store.updates).toHaveLength(0);
    expect(store.clears).toHaveLength(0);
  });

  test("still settles the session when promoting pending messages fails", async () => {
    const store = new FakeStore({
      sessions: [session()],
      branch: [record(streamingTurn())],
      failPromote: true,
    });

    await expect(recoverInterruptedRuns(store)).resolves.toHaveLength(1);
    expect(store.clears).toHaveLength(1);
  });
});
