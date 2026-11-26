import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  postChatCompletions as post,
  startProvider as start,
  useStartedProviders,
} from "./helpers.js";

describe("fake provider", () => {
  useStartedProviders();

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
      {
        method: "POST",
        path: "/v1/chat/completions",
        stream: true,
        body: { stream: true },
      },
    ]);
  });

  test("keeps the body each request carried", async () => {
    const provider = await start({
      scenario: { name: "answer", rules: [{ answer: "ok" }] },
    });
    const messages = [
      { role: "user", content: "what is in shot.png" },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          },
        ],
      },
    ];

    await post(provider.baseURL, { stream: true, messages });

    expect(provider.requests[0]?.body).toMatchObject({ messages });
  });

  test("answers a non-streaming request with a JSON completion", async () => {
    const provider = await start({
      scenario: { name: "title", rules: [{ answer: "假标题" }] },
    });

    const { response, text } = await post(provider.baseURL, { stream: false });

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(text).not.toContain("data:");
    expect(JSON.parse(text)).toMatchObject({
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "假标题" },
          finish_reason: "stop",
        },
      ],
      // 真供应商都带 `usage`；这里跟着写，形状才对得上。
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });

  test("writes malformed JSON when a non-streaming request is told corrupt", async () => {
    const provider = await start({
      scenario: { name: "corrupt-title", rules: [{ corrupt: true }] },
    });

    const { response, text } = await post(provider.baseURL, { stream: false });

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(text).not.toContain("data:");
    // 半截 JSON：客户端解析时会报错，这不是一条供应商错误。
    expect(() => {
      JSON.parse(text);
    }).toThrow(/Unexpected|JSON/u);
  });

  test("refuses a failMidStream rule on a non-streaming request", async () => {
    const provider = await start({
      scenario: {
        name: "mid-title",
        rules: [{ failMidStream: { text: "半句" } }],
      },
    });

    const { response, text } = await post(provider.baseURL, { stream: false });

    expect(response.status).toBe(500);
    expect(text).toContain("needs a streaming request");
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

  test("has the recording on disk when a sized response finishes", async () => {
    // 带 content-length 的上游：客户端收满字节就完成 body，不等结束信号。代理若把
    // 这个头原样传下去，客户端会抢在录制落盘之前去读文件。
    const answered = JSON.stringify({ ok: true });
    const plain = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(answered)),
      });
      response.end(answered);
    });
    await new Promise<void>((resolve) => {
      plain.listen(0, "127.0.0.1", resolve);
    });
    const address = plain.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const out = join(mkdtempSync(join(tmpdir(), "fake-provider-")), "one.json");

    try {
      const recorder = await start({
        record: { url: `http://127.0.0.1:${port}/v1`, out },
      });

      const { response, text } = await post(recorder.baseURL, {
        stream: false,
      });

      expect(response.headers.get("content-length")).toBeNull();

      const recorded = JSON.parse(readFileSync(out, "utf-8")) as {
        response: { status: number; body: string };
      }[];
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.response.status).toBe(200);
      expect(recorded[0]?.response.body).toBe(text);
    } finally {
      await new Promise<void>((resolve) => {
        plain.close(() => resolve());
        plain.closeAllConnections();
      });
    }
  });
});
