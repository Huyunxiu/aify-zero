import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, tool } from "ai";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { startFakeProvider } from "../../src/testing/fake-provider/index.js";
import type { FakeProvider } from "../../src/testing/fake-provider/index.js";

/** 一条「先要工具、再回答」的场景；两条协议测试共用。 */
const SCENARIO = {
  name: "tool-call",
  models: ["fake-fast"],
  rules: [
    { when: { stream: false }, answer: "标题" },
    {
      when: { stream: true },
      toolCall: {
        name: "edit-file",
        args: {
          path: "notes.md",
          edits: [{ oldText: "第二行", newText: "第二行已改" }],
        },
      },
    },
    { when: { stream: true }, answer: "改好了。" },
  ],
};

const running: FakeProvider[] = [];

const start = async (
  ...arguments_: Parameters<typeof startFakeProvider>
): Promise<FakeProvider> => {
  const provider = await startFakeProvider(...arguments_);
  running.push(provider);
  return provider;
};

/** 一条 SSE 数据块拆成对象；`[DONE]` 与空行丢掉。 */
const blocksOf = (text: string): Record<string, unknown>[] =>
  text
    .split("\n\n")
    .map((line) => line.replace(/^data: /u, "").trim())
    .filter((line) => line !== "" && line !== "[DONE]")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

type Delta = {
  readonly tool_calls?: readonly {
    readonly index: number;
    readonly id?: string;
    readonly type?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
};

const deltaOf = (block: Record<string, unknown>): Delta => {
  const choices = block.choices as { delta?: Delta }[] | undefined;
  return choices?.[0]?.delta ?? {};
};

describe("tool call outcome", () => {
  afterEach(async () => {
    await Promise.all(running.splice(0).map((provider) => provider.close()));
  });

  test("writes the call as incremental tool_calls chunks", async () => {
    const provider = await start({ scenario: SCENARIO });

    const response = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true }),
    });
    const text = await response.text();
    const blocks = blocksOf(text);
    const calls = blocks.flatMap((block) => deltaOf(block).tool_calls ?? []);

    // 名字与 id 只在第一块里，之后每块只有 arguments 的一段。
    expect(calls[0]).toMatchObject({
      index: 0,
      id: "call_fake_1",
      type: "function",
      function: { name: "edit-file", arguments: "" },
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(
      calls.slice(1).every((call) => call.function?.name === undefined)
    ).toBeTruthy();

    // 客户端把每段前缀拼起来，应该正好是场景里那个入参。
    const assembled = calls
      .map((call) => call.function?.arguments ?? "")
      .join("");
    expect(JSON.parse(assembled)).toStrictEqual(
      (SCENARIO.rules[1] as { toolCall: { args: unknown } }).toolCall.args
    );

    // 收尾说清楚这一轮为什么结束：不是 stop，是 tool_calls。
    const finishReasons = blocks
      .map(
        (block) =>
          (block.choices as { finish_reason?: string }[])[0]?.finish_reason
      )
      .filter(Boolean);
    expect(finishReasons).toStrictEqual(["tool_calls"]);
  });

  test("the AI SDK parses it back into the same tool call", async () => {
    const provider = await start({ scenario: SCENARIO });
    const model = createOpenAICompatible({
      name: "fake",
      baseURL: provider.baseURL,
      apiKey: "sk-test",
    }).chatModel("fake-fast");

    const result = streamText({
      model,
      prompt: "把 notes.md 的第二行改一下",
      tools: {
        "edit-file": tool({
          description: "改一个文件里的若干处文本",
          inputSchema: z.object({
            path: z.string(),
            edits: z.array(
              z.object({ oldText: z.string(), newText: z.string() })
            ),
          }),
        }),
      },
    });

    const calls = await result.toolCalls;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("edit-file");
    expect(calls[0]?.input).toStrictEqual({
      path: "notes.md",
      edits: [{ oldText: "第二行", newText: "第二行已改" }],
    });
  });
});
