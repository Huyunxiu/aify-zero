/**
 * `tests/testing/` 下两条协议测试共用的脚手架。
 *
 * 假供应商每次 test 都要收掉，所以启动的实例记在这里，由一个 `afterEach` 统一关。
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import { startFakeProvider } from "../../src/testing/fake-provider/index.js";
import type { FakeProvider } from "../../src/testing/fake-provider/index.js";

const running: FakeProvider[] = [];

/** 起一个假供应商；这条 test 结束时它会被关掉。 */
export const startProvider = async (
  ...arguments_: Parameters<typeof startFakeProvider>
): Promise<FakeProvider> => {
  const provider = await startFakeProvider(...arguments_);
  running.push(provider);
  return provider;
};

/** 往假供应商的 chat completions 端点发一次请求。 */
export const postChatCompletions = async (
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

/** 关掉这一条 test 里起过的所有实例。 */
export const closeStartedProviders = async (): Promise<void> => {
  await Promise.all(running.splice(0).map((provider) => provider.close()));
};

/** 关实例的那一步；各文件在自己的 `afterEach` 里调用。 */
export const useStartedProviders = (): void => {
  afterEach(closeStartedProviders);
};

/** 一份临时录制带；每次调用一个新目录。 */
export const tempTape = (): string =>
  join(mkdtempSync(join(tmpdir(), "tape-")), "session.jsonl");

/** 轮询一个状态，直到它成立；超时就算失败。 */
export const waitFor = async (
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

/** 一个只发两段 SSE 的上游；它替的是真供应商。 */
export const startUpstream = async (
  delays: readonly number[] = [0]
): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  let count = 0;

  const server = createServer((_request, response) => {
    // `delays` 按第几次请求决定「首块之前等多久」，用来制造「先发后到」的形状。
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
