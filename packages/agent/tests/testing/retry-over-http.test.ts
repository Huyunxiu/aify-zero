import { describe, expect, test } from "vitest";

import type { ModelTargetResolver } from "../../src/kernel/model-gateway.js";
import { startFakeProvider } from "../../src/testing/fake-provider/index.js";
import { testModel } from "../helpers/model-target.js";
import { FakeStore, makeAgent, runTurn } from "../helpers/turn-agent.js";

/**
 * 这一组走真正的 HTTP 与 SDK：不 mock `streamText`，不 mock 等待。
 *
 * 它证明的是协议那一段——`gateway.ts` 到 `createOpenAICompatible`，再到 SSE 解析
 * 与错误归一。内核的判定在 `retry-loop.test.ts` 里，两者不互相替代。
 */
const agentFor = (baseURL: string) => {
  const resolveModel: ModelTargetResolver = (ref) => ({
    ref,
    name: "fake-provider",
    protocol: "openai-chat",
    baseURL,
    apiKey: "test-key",
  });

  return makeAgent(new FakeStore(), { resolveModel });
};

const { modelId } = testModel();

describe("retry over a real HTTP provider", () => {
  test("retries a mid-stream provider error and finishes the turn", async () => {
    const fake = await startFakeProvider({
      scenario: {
        name: "mid-stream",
        models: [modelId],
        rules: [
          { when: { stream: false }, answer: "title" },
          { failMidStream: { text: "半句", error: { message: "overloaded" } } },
          { answer: "这一次说完了。" },
        ],
      },
    });

    try {
      const { agent, session } = agentFor(fake.baseURL);
      const { events, finished } = await runTurn(agent, "Hi.");

      expect(finished).toStrictEqual(["done"]);
      expect(events).toContain("step.retry");
      // 两次真正的流式请求：失败的那次，和重试的那次。
      expect(fake.requests.filter((request) => request.stream)).toHaveLength(2);

      const turn = session.turns.at(-1);
      const parts = (turn?.type === "assistant" ? turn.content : []).flatMap(
        (step) => (step.type === "assistant" ? step.content : [])
      );
      const retry = parts.find((part) => part.type === "retry");
      expect(retry).toMatchObject({
        type: "retry",
        index: 1,
        maxRetries: 5,
        reason: "overloaded",
      });
    } finally {
      await fake.close();
    }
  });

  test("waits what Retry-After says, not what the backoff would say", async () => {
    const fake = await startFakeProvider({
      scenario: {
        name: "retry-after",
        models: [modelId],
        rules: [
          { when: { stream: false }, answer: "title" },
          { fail: 503, retryAfterMs: 300 },
          { answer: "ok" },
        ],
      },
    });

    try {
      const { agent } = agentFor(fake.baseURL);
      const startedAt = Date.now();
      const { finished } = await runTurn(agent, "Hi.");
      const elapsed = Date.now() - startedAt;

      expect(finished).toStrictEqual(["done"]);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      // 退避第一次是 2 秒。明显短于它，才说明读的是响应头。
      expect(elapsed).toBeLessThan(1500);
    } finally {
      await fake.close();
    }
  });

  test("does not retry a refused request", async () => {
    const fake = await startFakeProvider({
      scenario: {
        name: "refused",
        models: [modelId],
        rules: [{ when: { stream: false }, answer: "title" }, { fail: 401 }],
      },
    });

    try {
      const { agent } = agentFor(fake.baseURL);
      const { events, finished } = await runTurn(agent, "Hi.");

      expect(finished).toStrictEqual(["error"]);
      expect(events).not.toContain("step.retry");
      expect(fake.requests.filter((request) => request.stream)).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });
});
