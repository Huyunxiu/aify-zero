/**
 * 一份现场写出来的录制带能驱动真实应用。
 *
 * 不用场景，用带：一条非流式的标题、一条流式的回答。回放模式按「流式与否」分流，
 * 因为真实应用会并发发一条标题请求，顺序会漂。
 *
 * 断言只看界面：回答出现、回合结束。这一条证明的是接缝——录制带 ↔ 供应商 ↔
 * 应用事件流 ↔ 界面。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { encodeFrameBytes, TapeRecorder } from "@workspace/agent/testing/tape";

import { PROJECT_NAME, startStack } from "./harness";
import type { Stack } from "./harness";

/** 编辑框的可访问名取自它自己的占位文案（`prompt-input-tiptap.tsx`）。 */
const COMPOSER_NAME = "What would you like to know?";

const SENT = "回放这一段";
const ANSWER = "回放收到。";

const chunk = (delta: object, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-fast",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const completion = (content: string): string =>
  JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion",
    created: 0,
    model: "fake-fast",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

/** 写一份最小的带：一条标题、一条回答。 */
const writeTape = async (path: string): Promise<void> => {
  const recorder = new TapeRecorder({ out: path });

  await recorder.recordRequest({
    at: 0,
    method: "POST",
    path: "/v1/chat/completions",
    stream: false,
    body: "{}",
    status: 200,
    headers: { "content-type": "application/json" },
    frames: [
      { at: 0, bytes: encodeFrameBytes(Buffer.from(completion("回放标题"))) },
    ],
    tailMs: 0,
  });

  const stream = [
    chunk({ role: "assistant" }),
    chunk({ content: "回放" }),
    chunk({ content: "收到。" }),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ].join("");

  await recorder.recordRequest({
    at: 10,
    method: "POST",
    path: "/v1/chat/completions",
    stream: true,
    body: "{}",
    status: 200,
    headers: { "content-type": "text/event-stream" },
    frames: [{ at: 0, bytes: encodeFrameBytes(Buffer.from(stream)) }],
    tailMs: 0,
  });
};

test("A recorded tape drives the app", async ({ page }) => {
  let stack: Stack | undefined;
  let failed = false;

  const tapePath = join(
    mkdtempSync(join(tmpdir(), "tape-e2e-")),
    "session.jsonl"
  );
  await writeTape(tapePath);

  try {
    stack = await startStack({ tape: tapePath });
    const { loginUrl } = stack;

    await page.goto(loginUrl);
    await expect(page.getByText("No projects", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New project" }).click();
    await page.getByPlaceholder("My project").fill(PROJECT_NAME);
    await page
      .getByPlaceholder("/Users/me/code/my-project")
      .fill(stack.projectDir);
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByText(PROJECT_NAME)).toBeVisible();

    await page.getByText(PROJECT_NAME).first().hover();
    await page
      .getByRole("button", { name: "New session in this project" })
      .click();

    const composer = page.getByRole("textbox", { name: COMPOSER_NAME });
    await composer.click();
    await page.keyboard.type(SENT);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("log").getByText(SENT)).toBeVisible();
    await expect(page.getByText(ANSWER)).toBeVisible();
    await expect(page.getByText("Finished", { exact: true })).toHaveCount(1);

    // 两层都数：界面说结束了，供应商那边也确实只被要过一条正文、一条标题。
    const streams = stack.fake.requests.filter((request) => request.stream);
    const titles = stack.fake.requests.filter((request) => !request.stream);

    expect(streams).toHaveLength(1);
    expect(titles).toHaveLength(1);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stack?.stop({
      keep: failed || process.env.E2E_KEEP_ARTIFACTS === "1",
    });
  }
});
