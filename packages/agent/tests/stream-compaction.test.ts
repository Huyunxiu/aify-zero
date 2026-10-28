import type { AgentStreamEvent, AgentTurn } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { AgentContext } from "../src/agent-context.js";
import { AgentSession } from "../src/agent-session.js";
import { Agent, NothingToCompactError } from "../src/agents.js";
import { resolvePolicy } from "../src/compaction/policy.js";
import type {
  ResolvedCompactionPolicy,
  SummarizeFn,
} from "../src/compaction/types.js";
import { SkillManager } from "../src/skill/index.js";
import type { AgentStore } from "../src/storage/index.js";
import type { AgentToolSet } from "../src/types.js";
import {
  asTurns,
  assistantStep,
  assistantTurn,
  userTurn,
} from "./compaction/fixtures.js";

const longText = "x".repeat(20_000);

/** 一段值得压缩的历史：两个大 turn，外加一条要原文保留的最新用户请求。 */
const compactableTurns = (): AgentTurn<AgentToolSet>[] =>
  asTurns(
    userTurn("u1", longText),
    assistantTurn("a1", [assistantStep("s1", { text: longText })]),
    userTurn("u2", "keep me")
  );

/** 只实现压缩路径用到的写入。 */
class FakeStore {
  readonly inserted: Parameters<AgentStore["insertTurnInBranch"]>[0]["turn"][] =
    [];

  insertTurnInBranch(
    input: Parameters<AgentStore["insertTurnInBranch"]>[0]
  ): Promise<void> {
    this.inserted.push(input.turn);
    return Promise.resolve();
  }
}

const asStore = (store: FakeStore): AgentStore =>
  store as unknown as AgentStore;

const policy = (
  overrides: Partial<ResolvedCompactionPolicy> = {}
): ResolvedCompactionPolicy => ({
  ...resolvePolicy({ contextWindow: 128_000 }),
  keepRecentTokens: 1,
  minSummarizeTokens: 1,
  pruneToolResults: false,
  ...overrides,
});

const buildAgent = (
  store: FakeStore,
  summarize: SummarizeFn = () =>
    Promise.resolve({
      text: "A short structured summary.",
      finishReason: "stop",
    })
): Agent =>
  new Agent({
    name: "main",
    sessionId: "session-1",
    session: new AgentSession({ turns: [] }),
    store: asStore(store),
    context: new AgentContext({
      sessionId: "session-1",
      projectDirs: ["/tmp"],
      sessionDir: "/tmp/sessions/session-1",
      modelId: "test-model",
      skills: new SkillManager({ dirs: [] }),
      compaction: policy(),
      summarize,
    }),
    apiKey: "test-key",
    apiUrl: "http://localhost",
    providerId: "test-provider",
    modelId: "test-model",
  });

const readAll = async (
  stream: ReadableStream<AgentStreamEvent<AgentToolSet>>
): Promise<AgentStreamEvent<AgentToolSet>[]> => {
  const events: AgentStreamEvent<AgentToolSet>[] = [];
  const reader = stream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    events.push(value);
  }

  return events;
};

describe("手工压缩的 stream signal", () => {
  test("摘要写成一条独立的 compaction turn 并落库", async () => {
    const store = new FakeStore();
    const agent = buildAgent(store);
    const finished: string[] = [];

    const stream = await agent.stream({
      turns: compactableTurns(),
      modelId: "test-model",
      streamId: "test-stream",
      signal: { type: "compaction", trigger: "manual" },
      onFinish: (status) => {
        finished.push(status);
        return Promise.resolve();
      },
    });

    const events = await readAll(stream);

    expect(events).toMatchObject([
      { type: "turn.start", turnType: "compaction" },
      { type: "step.start" },
      { type: "compaction.start" },
      { type: "compaction.end" },
      { type: "step.finish" },
      { type: "turn.finish" },
    ]);

    const [start] = events;
    if (start?.type !== "turn.start") {
      throw new Error("missing turn.start");
    }
    const end = events.find((event) => event.type === "compaction.end");
    const startMarker = events.find(
      (event) => event.type === "compaction.start"
    );
    if (
      end?.type !== "compaction.end" ||
      startMarker?.type !== "compaction.start"
    ) {
      throw new Error("missing compaction boundary");
    }
    // 手工路径的 part 与记录共用一个 id，切点写在记录里。
    expect(end.record).toMatchObject({
      id: startMarker.id,
      retainedFromTurnId: "u2",
      trigger: "manual",
    });

    const [inserted] = store.inserted;
    // 压缩 turn 线性追加：挂在原 head 下，不再改写保留段的 parentId。
    expect(inserted).toMatchObject({
      parentId: "u2",
      type: "compaction",
    });

    const turn = inserted!.content;
    expect(turn).toMatchObject({
      id: start.id,
      status: "done",
      type: "compaction",
    });

    expect(finished).toStrictEqual(["done"]);
  });

  test("没有可压缩内容时同步失败，不产生流", async () => {
    const store = new FakeStore();
    const agent = buildAgent(store);

    await expect(
      agent.stream({
        turns: asTurns(userTurn("u1", "hi")),
        modelId: "test-model",
        streamId: "test-stream",
        signal: { type: "compaction", trigger: "manual" },
        onFinish: async () => {},
      })
    ).rejects.toBeInstanceOf(NothingToCompactError);
    expect(store.inserted).toHaveLength(0);
  });

  test("abort 撤掉 streaming 标记并以 canceled 收尾", async () => {
    const store = new FakeStore();
    const agent = buildAgent(
      store,
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        })
    );
    const finished: string[] = [];

    const stream = await agent.stream({
      turns: compactableTurns(),
      modelId: "test-model",
      streamId: "test-stream",
      signal: { type: "compaction", trigger: "manual" },
      onFinish: (status) => {
        finished.push(status);
        return Promise.resolve();
      },
    });

    agent.abort();
    const events = await readAll(stream);

    expect(events.map((event) => event.type)).toContain("compaction.error");
    expect(events.map((event) => event.type)).not.toContain("turn.finish");
    expect(store.inserted).toHaveLength(0);
    expect(finished).toStrictEqual(["canceled"]);
  });
});
