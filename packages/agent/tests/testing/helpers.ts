/**
 * `tests/testing/` 下两条协议测试共用的脚手架。
 *
 * 假供应商每次 test 都要收掉，所以启动的实例记在这里，由一个 `afterEach` 统一关。
 */
import { mkdtempSync } from "node:fs";
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
