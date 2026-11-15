import { APICallError, StreamProviderError } from "ai";
import type * as AiModule from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { convertAgentTurnToModalMessage } from "../../src/utils/convert-to-model-message.js";
import {
  script,
  stepResult,
  streamTextMock,
} from "../helpers/stream-harness.js";
import { FakeStore, makeAgent, runTurn } from "../helpers/turn-agent.js";

// 等待由 `wait-for` 的单元测试盯住；这里只走循环与记录，不花真实时间。
vi.mock(import("../../src/utils/wait-for.js"), () => ({
  waitFor: () => Promise.resolve(),
}));

vi.mock(import("ai"), async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    streamText: vi.fn<
      typeof AiModule.streamText
    >() as unknown as typeof actual.streamText,
  };
});

const apiCallError = (statusCode: number, isRetryable: boolean) =>
  new APICallError({
    message: statusCode === 429 ? "Too Many Requests" : "Unauthorized request",
    url: "https://example.test/v1/chat",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });

/** 这一步以 `finishReason: "error"` 结束，也就是流到一半供应商报错。 */
const streamFailure = () =>
  new StreamProviderError({
    message: "provider failed after the stream started",
    statusCode: 503,
    isRetryable: true,
  });

describe("retry steps", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  test("retries a retryable failure in the same turn", async () => {
    const store = new FakeStore();
    const { agent, session } = makeAgent(store);

    streamTextMock.mockImplementationOnce(() => {
      throw apiCallError(429, true);
    });
    script(stepResult({ text: "recovered" }));

    const { events, finished } = await runTurn(agent, "Hi.");

    expect({
      events,
      finished,
      // 失败的那一步没有 `step.finish`，所以只有成功那一步落库。
      saved: store.savedSteps.map((step) => step.status),
    }).toStrictEqual({
      // 第二步先开（`step.start`），再写它的重试记录，然后才是这一次的流。
      events: [
        "turn.start",
        "step.start",
        "step.start",
        "step.retry",
        "step.finish",
        "turn.finish",
      ],
      finished: ["done"],
      saved: ["done"],
    });

    const turn = session.turns.at(-1);
    const retryStep = turn?.content.at(-1);
    if (retryStep?.type !== "assistant") {
      throw new Error("expected the retry step to be the last one");
    }
    expect(retryStep.content[0]).toStrictEqual({
      type: "retry",
      index: 1,
      maxRetries: 5,
      reason: "Too Many Requests",
      createdAt: expect.any(Number),
    });
  });

  test("tells the step hooks which retry this is", async () => {
    const { agent } = makeAgent(new FakeStore());
    const seen: (number | undefined)[] = [];
    agent.hooks.on("step_start", (event) => {
      seen.push(event.retryIndex);
    });

    streamTextMock.mockImplementationOnce(() => {
      throw apiCallError(429, true);
    });
    script(stepResult({ text: "ok" }));

    await runTurn(agent, "Hi.");

    // 第一次请求没有这个字段；重试的那一步是第 1 次重试。
    expect(seen).toStrictEqual([undefined, 1]);
  });

  test("leaves the SDK's own retries off", async () => {
    const { agent } = makeAgent(new FakeStore());

    script(stepResult({ text: "Hello." }));
    await runTurn(agent, "Hi.");

    const call = streamTextMock.mock.calls[0]?.[0];
    expect(call?.maxRetries).toBe(0);
    expect(call?.streamRetries).toBe(0);
  });

  test("does not retry a request the provider refused", async () => {
    const store = new FakeStore();
    const { agent } = makeAgent(store);

    streamTextMock.mockImplementationOnce(() => {
      throw apiCallError(401, false);
    });

    const { events, finished } = await runTurn(agent, "Hi.");

    expect({ events, finished, saved: store.savedSteps }).toStrictEqual({
      events: ["turn.start", "step.start", "turn.finish"],
      finished: ["error"],
      saved: [],
    });
  });

  test("closes the failed attempt and keeps it out of history", async () => {
    const store = new FakeStore();
    const { agent, session } = makeAgent(store);

    script(
      stepResult({ text: "partial ", error: streamFailure() }),
      stepResult({ text: "" })
    );

    const { finished } = await runTurn(agent, "Hi.");
    expect(finished).toStrictEqual(["done"]);

    const turn = session.turns.at(-1);
    const [failed, retry] = turn?.content ?? [];
    if (failed?.type !== "assistant") {
      throw new Error("expected the failed attempt to be an assistant step");
    }

    // 失败的那一次不落行，但它流出的 part 已经画在屏幕上：必须收尾。
    expect({
      status: failed.status,
      text: failed.content[0],
      saved: store.savedSteps.map((step) => step.status),
    }).toMatchObject({
      status: "error",
      text: { type: "text", text: "partial ", state: "done" },
      saved: ["done"],
    });
    expect(retry?.type).toBe("assistant");

    // 它也不是历史：模型没有说完，这句话不能当成它说过的话。
    await expect(
      convertAgentTurnToModalMessage(turn ? [turn] : [])
    ).resolves.toStrictEqual([]);
  });

  test("stops at the budget, numbering the retries 1 to 5", async () => {
    const store = new FakeStore();
    const { agent, session } = makeAgent(store);

    streamTextMock.mockImplementation(() => {
      throw apiCallError(429, true);
    });

    const { events, finished } = await runTurn(agent, "Hi.");

    // 第一次请求加 5 次重试：每次失败都留下 `step.retry`，最后一次不再排。
    expect({
      starts: events.filter((type) => type === "step.start").length,
      retries: events.filter((type) => type === "step.retry").length,
      finished,
      saved: store.savedSteps,
    }).toStrictEqual({
      starts: 6,
      retries: 5,
      finished: ["error"],
      saved: [],
    });

    const turn = session.turns.at(-1);
    const indices = (turn?.content ?? [])
      .filter((step) => step.type === "assistant")
      .map(
        (step) =>
          step.content.find((part) => part.type === "retry")?.index ?? null
      )
      .filter((index) => index !== null);
    expect(indices).toStrictEqual([1, 2, 3, 4, 5]);
  });
});
