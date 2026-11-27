import { createAgentRunner } from "@workspace/agent";
import type {
  Agent,
  AgentRunner,
  AgentRunnerStore,
  SessionRecord,
} from "@workspace/agent";
import { describe, expect, test, vi } from "vitest";

const session = (id: string): SessionRecord => ({
  id,
  title: "",
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
  approvalPolicy: "edit",
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

type Turn = Parameters<AgentRunner["enqueue"]>[0]["turn"];

const turn = (id: string): Turn =>
  ({
    id,
    type: "user",
    createdAt: 1,
    status: "done",
    content: [
      {
        id: `${id}-step`,
        type: "user",
        createdAt: 1,
        status: "done",
        content: [{ type: "text", text: id, createdAt: 1 }],
      },
    ],
  }) as Turn;

/** 只实现这条路径会用到的方法；其余由 `AgentRunnerStore` 的断言补齐。 */
class Store {
  readonly sessions = new Map<string, SessionRecord>();
  readonly cleared: string[] = [];
  readonly items = new Map<string, unknown>();
  readonly claimed = new Set<string>();

  constructor(entry: SessionRecord) {
    this.sessions.set(entry.id, entry);
  }

  getSessionById(id: string) {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  findSessionRow(id: string) {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  saveSession(write: { id: string }) {
    this.sessions.set(write.id, session(write.id));
    return Promise.resolve(true);
  }

  insertInboxItem(input: {
    sessionId: string;
    dedupeKey: string;
    deliverAt: "step-boundary" | "run-boundary";
    content: Turn;
    payload: unknown;
  }) {
    return Promise.resolve({
      seq: 0,
      id: `${input.sessionId}-${input.dedupeKey}`,
      sessionId: input.sessionId,
      kind: "user-message" as const,
      dedupeKey: input.dedupeKey,
      deliverAt: input.deliverAt,
      content: input.content,
      payload: input.payload as never,
      createdAt: 1,
    });
  }

  listInboxItems(sessionId: string) {
    const key = `${sessionId}-item`;
    if (this.claimed.has(key)) {
      return Promise.resolve([]);
    }

    this.claimed.add(key);
    return Promise.resolve([
      {
        seq: 0,
        id: key,
        sessionId,
        kind: "user-message" as const,
        dedupeKey: "dedupe",
        deliverAt: "run-boundary" as const,
        content: turn("turn-1"),
        payload: {
          model: { providerId: "test", modelId: "test-model" },
        },
        createdAt: 1,
      },
    ]);
  }

  listPendingInboxSessionIds() {
    return Promise.resolve([]);
  }

  listInterruptedSessions() {
    return Promise.resolve([]);
  }

  getBranchTurns() {
    return Promise.resolve([]);
  }

  setActiveStream() {
    return Promise.resolve(1);
  }

  clearActiveStream(_sessionId: string, streamId: string) {
    this.cleared.push(streamId);
    return Promise.resolve(1);
  }

  listChildSessions() {
    return Promise.resolve([]);
  }

  updateTurn() {
    return Promise.resolve(0);
  }
}

describe("public API", () => {
  test("enqueue 起一次运行并落定，只用包根入口", async () => {
    const store = new Store(session("s1"));
    const runner = createAgentRunner({
      store: store as unknown as AgentRunnerStore,
      buildAgent: () =>
        Promise.resolve({
          stream: (options: {
            onFinish: (status: "done") => Promise<void>;
          }) => {
            void options.onFinish("done");
            return Promise.resolve(
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              })
            );
          },
          dispose: () => Promise.resolve(),
        } as unknown as Agent),
    });

    await runner.createSession({ sessionId: "s1" });
    await runner.enqueue({
      sessionId: "s1",
      turn: turn("turn-1"),
      model: { providerId: "test", modelId: "test-model" },
    });

    await vi.waitFor(() => {
      expect(store.cleared).toHaveLength(1);
      expect(runner.state().paused).toStrictEqual([]);
    });

    await runner.shutdown();
  });
});
