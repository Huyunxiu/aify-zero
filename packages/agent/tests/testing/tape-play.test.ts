import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  encodeFrameBytes,
  TapeRecorder,
} from "../../src/testing/tape/index.js";
import {
  postChatCompletions as post,
  startProvider,
  useStartedProviders,
} from "./helpers.js";

const tempTape = (): string =>
  join(mkdtempSync(join(tmpdir(), "tape-play-")), "session.jsonl");

/** 轮询一个状态，直到它成立；超时就算失败。 */
const waitFor = async (
  check: () => boolean,
  timeoutMs = 2000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

type Entry = {
  readonly stream?: boolean;
  readonly frames: readonly { at: number; text: string }[];
};

/** 写一份录制带；前面故意放一条输入事件，证明播放器会跳过它。 */
const writeTape = async (
  out: string,
  entries: readonly Entry[]
): Promise<void> => {
  const recorder = new TapeRecorder({ out });
  await recorder.recordInput(0, { type: "user", summary: "先来一条输入" });

  for (const entry of entries) {
    await recorder.recordRequest({
      at: 0,
      method: "POST",
      path: "/v1/chat/completions",
      stream: entry.stream ?? true,
      body: "{}",
      status: 200,
      headers: { "content-type": "text/event-stream" },
      frames: entry.frames.map((frame) => ({
        at: frame.at,
        bytes: encodeFrameBytes(Buffer.from(frame.text)),
      })),
      tailMs: 0,
    });
  }
};

describe("tape player", () => {
  useStartedProviders();

  test("plays the frames in order", async () => {
    const out = tempTape();
    await writeTape(out, [
      {
        frames: [
          { at: 0, text: "data: a\n\n" },
          { at: 60, text: "data: b\n\n" },
        ],
      },
    ]);

    const provider = await startProvider({ play: { path: out } });
    const { text } = await post(provider.baseURL, { stream: true });

    expect(text).toBe("data: a\n\ndata: b\n\n");
  });

  test("waits between frames at the recorded pace", async () => {
    const out = tempTape();
    await writeTape(out, [
      {
        frames: [
          { at: 0, text: "data: a\n\n" },
          { at: 120, text: "data: b\n\n" },
        ],
      },
    ]);

    const provider = await startProvider({ play: { path: out } });

    const started = performance.now();
    await post(provider.baseURL, { stream: true });
    const elapsed = performance.now() - started;

    // 120ms 的间隔至少放出去大半；断得太紧会被机器负载打翻。
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  test("takes entries in order and skips input items", async () => {
    const out = tempTape();
    await writeTape(out, [
      { frames: [{ at: 0, text: "data: 第一\n\n" }] },
      { frames: [{ at: 0, text: "data: 第二\n\n" }] },
    ]);

    const provider = await startProvider({ play: { path: out } });

    const first = await post(provider.baseURL, { stream: true });
    const second = await post(provider.baseURL, { stream: true });

    expect(first.text).toBe("data: 第一\n\n");
    expect(second.text).toBe("data: 第二\n\n");
  });

  test("reports when the tape is used up", async () => {
    const out = tempTape();
    await writeTape(out, [{ frames: [{ at: 0, text: "data: a\n\n" }] }]);

    const provider = await startProvider({ play: { path: out } });
    await post(provider.baseURL, { stream: true });

    const { response, text } = await post(provider.baseURL, { stream: true });

    expect(response.status).toBe(500);
    expect(text).toContain("is used up");
  });

  test("caps a long idle gap", async () => {
    const out = tempTape();
    await writeTape(out, [
      // 十秒的空闲：原速播会等十秒，截断之后应该几乎立刻结束。
      {
        frames: [
          { at: 0, text: "data: a\n\n" },
          { at: 10_000, text: "data: b\n\n" },
        ],
      },
    ]);

    const provider = await startProvider({
      play: { path: out, capMs: 50 },
    });

    const started = performance.now();
    await post(provider.baseURL, { stream: true });

    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("plays a non-streaming entry as one frame", async () => {
    const out = tempTape();
    await writeTape(out, [
      {
        stream: false,
        frames: [{ at: 0, text: '{"object":"chat.completion"}' }],
      },
    ]);

    const provider = await startProvider({ play: { path: out } });
    const { text } = await post(provider.baseURL, { stream: false });

    expect(text).toBe('{"object":"chat.completion"}');
  });

  test("holds at the given frame until resumed", async () => {
    const out = tempTape();
    await writeTape(out, [
      {
        frames: [
          { at: 0, text: "data: a\n\n" },
          { at: 0, text: "data: b\n\n" },
          { at: 0, text: "data: c\n\n" },
        ],
      },
    ]);

    const provider = await startProvider({ play: { path: out, pauseAt: 2 } });

    const pending = post(provider.baseURL, { stream: true });
    await waitFor(() => provider.tape?.paused === true);

    // 挂起时前两帧已经发出，第三帧还没写。
    expect(provider.tape?.frames).toBe(2);

    const resumed = await fetch(new URL("/__tape/resume", provider.baseURL), {
      method: "POST",
    });

    expect(resumed.status).toBe(204);

    const { text } = await pending;

    expect(text).toBe("data: a\n\ndata: b\n\ndata: c\n\n");
    expect(provider.tape?.paused).toBeFalsy();
  });
});
