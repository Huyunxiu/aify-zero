import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { startFakeProvider } from "../../src/testing/fake-provider/index.js";
import type { FakeProvider } from "../../src/testing/fake-provider/index.js";

const running: FakeProvider[] = [];

const start = async (
  ...arguments_: Parameters<typeof startFakeProvider>
): Promise<FakeProvider> => {
  const provider = await startFakeProvider(...arguments_);
  running.push(provider);
  return provider;
};

const post = async (
  baseURL: string,
  body: unknown
): Promise<{ response: Response; text: string }> => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { response, text: await response.text() };
};

describe("fake provider", () => {
  afterEach(async () => {
    await Promise.all(running.splice(0).map((provider) => provider.close()));
  });

  test("lists the models the scenario declares", async () => {
    const provider = await start({
      scenario: {
        name: "list",
        models: ["fast", "slow"],
        rules: [{ answer: "" }],
      },
    });

    const response = await fetch(`${provider.baseURL}/models`);
    const body = (await response.json()) as { data: { id: string }[] };

    expect(body.data.map((model) => model.id)).toStrictEqual(["fast", "slow"]);
  });

  test("streams an answer in chat completions chunks", async () => {
    const provider = await start({
      scenario: { name: "answer", rules: [{ answer: "你好" }] },
    });

    const { text } = await post(provider.baseURL, { stream: true });

    expect(text).toContain('"content":"你"');
    expect(text).toContain('"content":"好"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBeTruthy();
    expect(provider.requests).toStrictEqual([
      { method: "POST", path: "/v1/chat/completions", stream: true },
    ]);
  });

  test("fails with a status and the Retry-After header it was told", async () => {
    const provider = await start({
      scenario: {
        name: "fail",
        rules: [{ fail: 429, retryAfter: 7, retryAfterMs: 250 }],
      },
    });

    const { response } = await post(provider.baseURL, { stream: true });

    expect({
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      retryAfterMs: response.headers.get("retry-after-ms"),
    }).toStrictEqual({ status: 429, retryAfter: "7", retryAfterMs: "250" });
  });

  test("sends a partial answer and then a mid-stream error", async () => {
    const provider = await start({
      scenario: {
        name: "mid",
        rules: [
          { failMidStream: { text: "半句", error: { message: "overloaded" } } },
        ],
      },
    });

    const { text } = await post(provider.baseURL, { stream: true });

    expect(text).toContain('"content":"半"');
    expect(text).toContain('{"error":{"message":"overloaded"}}');
    expect(text).not.toContain("[DONE]");
  });

  test("waits before the first chunk when told to be slow", async () => {
    const provider = await start({
      scenario: {
        name: "slow",
        rules: [{ answer: "ok", slow: { firstChunkMs: 200 } }],
      },
    });

    const startedAt = Date.now();
    await post(provider.baseURL, { stream: true });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
  });

  test("drops the connection when the scenario says reset", async () => {
    const provider = await start({
      scenario: { name: "reset", rules: [{ reset: true }] },
    });

    await expect(post(provider.baseURL, { stream: true })).rejects.toThrow(
      /failed|reset|socket|closed/i
    );
  });

  test("writes a broken chunk when the scenario says corrupt", async () => {
    const provider = await start({
      scenario: { name: "corrupt", rules: [{ corrupt: true }] },
    });

    const { text } = await post(provider.baseURL, { stream: true });

    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).not.toContain("[DONE]");
  });

  test("answers 500 once the scenario runs out of rules", async () => {
    const provider = await start({
      scenario: { name: "one", rules: [{ answer: "only" }] },
    });

    await post(provider.baseURL, { stream: true });
    const { response, text } = await post(provider.baseURL, { stream: true });

    expect(response.status).toBe(500);
    expect(text).toContain("ran out of rules");
  });

  test("records a real exchange and replays it byte for byte", async () => {
    const upstream = await start({
      scenario: { name: "upstream", rules: [{ answer: "录下来" }] },
    });
    const out = join(mkdtempSync(join(tmpdir(), "fake-provider-")), "one.json");
    const recorder = await start({ record: { url: upstream.baseURL, out } });

    const recorded = await post(recorder.baseURL, { stream: true });
    expect(JSON.parse(readFileSync(out, "utf-8"))).toHaveLength(1);

    const replayed = await start({
      scenario: { name: "replay", rules: [{ replay: out }] },
    });
    const body = await post(replayed.baseURL, { stream: true });

    expect(body.text).toBe(recorded.text);
    // 答案按字符分块发出，所以断言单个字符，而不是整句。
    expect(body.text).toContain('"content":"录"');
  });
});
