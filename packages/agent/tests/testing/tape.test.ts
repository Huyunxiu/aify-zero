import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  decodeFrameBytes,
  encodeFrameBytes,
  eventFrameIndexes,
  parseTapeLine,
  TapeRecorder,
} from "../../src/testing/tape/index.js";
import type { TapeFrame, TapeItem } from "../../src/testing/tape/index.js";
import {
  postChatCompletions as post,
  startProvider,
  useStartedProviders,
} from "./helpers.js";

/** 一份临时录制带；每次 test 一个目录。 */
const tempTape = (): string =>
  join(mkdtempSync(join(tmpdir(), "tape-")), "session.jsonl");

const readTape = (path: string): TapeItem[] =>
  readFileSync(path, "utf-8")
    .trimEnd()
    .split("\n")
    .map((line) => parseTapeLine(line));

/** 轮询一个状态，直到它成立；超时就算失败。 */
const waitFor = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

const frame = (text: string): TapeFrame => ({
  at: 0,
  bytes: encodeFrameBytes(Buffer.from(text)),
});

/**
 * 一个只发两段 SSE 的上游；它替的是真供应商。
 *
 * `delays` 按第几次请求决定「首块之前等多久」，用来制造「先发后到」的形状。
 */
const startUpstream = async (
  delays: readonly number[] = [0]
): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  let count = 0;

  const server = createServer((_request, response) => {
    const delay = delays[Math.min(count, delays.length - 1)] ?? 0;
    count += 1;

    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: a\n\n");
      setTimeout(() => {
        response.write("data: b\n\n");
        response.end();
      }, 10);
    }, delay);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

describe(eventFrameIndexes, () => {
  test("counts two events that end in one frame", () => {
    expect(eventFrameIndexes([frame("data: a\n\ndata: b\n\n")])).toStrictEqual([
      0, 0,
    ]);
  });

  test("counts an event that spans two frames", () => {
    expect(eventFrameIndexes([frame("data: a"), frame("\n\n")])).toStrictEqual([
      1,
    ]);
  });

  test("accepts CRLF separators", () => {
    expect(eventFrameIndexes([frame("data: a\r\n\r\n")])).toStrictEqual([0]);
  });

  test("returns nothing while no event is complete", () => {
    expect(eventFrameIndexes([frame("data: a")])).toStrictEqual([]);
  });

  test("keeps bytes that are split inside a multi-byte character", () => {
    // 「我」是三个字节；按文本存会在帧边界坏掉。回放写的是字节，不是字符，
    // 所以先拼字节再解码才是正确的读法。
    const encoded = Buffer.from("我");
    const frames: TapeFrame[] = [
      { at: 0, bytes: encoded.subarray(0, 1).toString("base64") },
      { at: 1, bytes: encoded.subarray(1).toString("base64") },
    ];

    const joined = Buffer.concat(
      frames.map((item) => decodeFrameBytes(item.bytes))
    );

    expect(joined.toString("utf-8")).toBe("我");
  });
});

describe("tape recorder", () => {
  test("writes a header before the first item", async () => {
    const out = tempTape();
    const recorder = new TapeRecorder({ out });

    await recorder.recordRequest({
      at: 0,
      method: "POST",
      path: "/v1/chat/completions",
      stream: true,
      body: '{"stream":true}',
      status: 200,
      headers: { "content-type": "text/event-stream" },
      frames: [frame("data: a\n\n")],
      tailMs: 3,
    });

    const items = readTape(out);

    expect(items[0]).toMatchObject({ kind: "header", version: 1 });
    expect(items[1]).toMatchObject({
      kind: "request",
      at: 0,
      entry: { request: { body: '{"stream":true}' }, response: { tailMs: 3 } },
    });
  });

  test("replaces the body with a digest when redacted", async () => {
    const out = tempTape();
    const recorder = new TapeRecorder({ out, redact: true });

    await recorder.recordRequest({
      at: 5,
      method: "POST",
      path: "/v1/chat/completions",
      stream: true,
      body: '{"stream":true}',
      status: 200,
      headers: {},
      frames: [],
      tailMs: 0,
    });

    const [, item] = readTape(out);

    if (item?.kind !== "request") {
      throw new Error("expected a request item");
    }

    expect(item.entry.request.body).toBeUndefined();
    expect(item.entry.request.bodyDigest).toMatch(/^sha256:/);
    expect(item.entry.request.bodyBytes).toBe(15);
  });

  test("keeps the header of an existing tape", async () => {
    const out = tempTape();
    const first = new TapeRecorder({ out });
    await first.recordInput(0, { type: "user", summary: "第一条" });

    const second = new TapeRecorder({ out });
    await second.recordInput(10, { type: "user", summary: "第二条" });

    const items = readTape(out);

    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.kind === "header")).toHaveLength(1);
  });
});

describe("tape over the proxy", () => {
  useStartedProviders();

  test("records every forwarded chunk as a frame", async () => {
    const upstream = await startUpstream();

    try {
      const out = tempTape();
      const provider = await startProvider({
        record: { url: upstream.url },
        tape: { out },
      });

      await post(provider.baseURL, { stream: true, model: "deepseek-chat" });

      const items = readTape(out);
      const request = items.find((item) => item.kind === "request");

      if (request?.kind !== "request") {
        throw new Error("expected a request item");
      }

      const { frames } = request.entry.response;
      const joined = Buffer.concat(
        frames.map((item) => decodeFrameBytes(item.bytes))
      ).toString("utf-8");

      expect(joined).toBe("data: a\n\ndata: b\n\n");
      expect(request.entry.response.eventFrames).toHaveLength(2);
      expect(request.entry.response.eventFrames.at(-1)).toBe(frames.length - 1);
      // 首帧紧跟请求到达，只差处理时间；它不该是负的，也不该等很久。
      expect(frames[0]?.at).toBeLessThan(100);
    } finally {
      await upstream.close();
    }
  });

  test("orders entries by arrival, not by completion", async () => {
    // 第一个请求慢，第二个快；按「完成时刻」排会把它俩的顺序弄反。
    const upstream = await startUpstream([150, 0]);

    try {
      const out = tempTape();
      const provider = await startProvider({
        record: { url: upstream.url },
        tape: { out },
      });

      const slow = post(provider.baseURL, { stream: true, model: "slow" });
      // 等它真的到达，别靠时间差猜：首次建连比复用连接慢。
      await waitFor(() => provider.requests.length === 1);

      const fast = post(provider.baseURL, { stream: true, model: "fast" });

      await Promise.all([slow, fast]);

      const entries = readTape(out).flatMap((item) =>
        item.kind === "request"
          ? [{ model: item.entry.request.model, at: item.at }]
          : []
      );
      const slowAt = entries.find((entry) => entry.model === "slow")?.at;
      const fastAt = entries.find((entry) => entry.model === "fast")?.at;

      expect(slowAt).toBeDefined();
      expect(fastAt).toBeDefined();
      expect(slowAt!).toBeLessThan(fastAt!);
    } finally {
      await upstream.close();
    }
  });

  test("keeps the wait before the first chunk", async () => {
    // 慢模型的首块延迟是体验的一部分，回放不能把它抹掉。
    const upstream = await startUpstream([120]);

    try {
      const out = tempTape();
      const provider = await startProvider({
        record: { url: upstream.url },
        tape: { out },
      });

      await post(provider.baseURL, { stream: true });

      const items = readTape(out);
      const request = items.find((item) => item.kind === "request");

      if (request?.kind !== "request") {
        throw new Error("expected a request item");
      }

      expect(request.entry.response.frames[0]?.at).toBeGreaterThanOrEqual(80);
    } finally {
      await upstream.close();
    }
  });

  test("accepts an input event on the control endpoint", async () => {
    const upstream = await startUpstream();

    try {
      const out = tempTape();
      const provider = await startProvider({
        record: { url: upstream.url },
        tape: { out },
      });

      const response = await fetch(new URL("/__tape/input", provider.baseURL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", summary: "把标题改一下" }),
      });

      expect(response.status).toBe(204);

      const input = readTape(out).find((item) => item.kind === "input");

      expect(input).toMatchObject({
        kind: "input",
        input: { type: "user", summary: "把标题改一下" },
      });
    } finally {
      await upstream.close();
    }
  });

  test("answers 404 when no tape is open", async () => {
    const upstream = await startUpstream();

    try {
      const provider = await startProvider({ record: { url: upstream.url } });

      const response = await fetch(new URL("/__tape/input", provider.baseURL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", summary: "x" }),
      });

      expect(response.status).toBe(404);
    } finally {
      await upstream.close();
    }
  });
});
