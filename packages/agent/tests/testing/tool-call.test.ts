/**
 * `toolCall` 这条结果在 chat completions 上长什么样。
 *
 * 场景取自 `scenarios/edit-then-answer.json`——端到端用例读的也是它，两边不各写
 * 一份。这里只能证明「假供应商的分块能被客户端解析回同一个工具调用」；它不能证
 * 明假供应商与真供应商同形，那种漂移要靠录制回放才发现。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, tool } from "ai";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  postChatCompletions,
  startProvider,
  useStartedProviders,
} from "./helpers.js";

const SCENARIO = "edit-then-answer";

/** 场景里那次工具调用要改的东西；断言直接从这条事实出发。 */
const EXPECTED_ARGS = {
  path: "notes.md",
  edits: [{ oldText: "第二行", newText: "第二行已改" }],
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
  useStartedProviders();

  test("writes the call as incremental tool_calls chunks", async () => {
    const provider = await startProvider({ scenario: SCENARIO });

    const { text } = await postChatCompletions(provider.baseURL, {
      stream: true,
    });
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
    expect(JSON.parse(assembled)).toStrictEqual(EXPECTED_ARGS);

    // 收尾说清楚这一次为什么结束：不是 stop，是 tool_calls。
    const finishReasons = blocks
      .map(
        (block) =>
          (block.choices as { finish_reason?: string }[])[0]?.finish_reason
      )
      .filter(Boolean);
    expect(finishReasons).toStrictEqual(["tool_calls"]);
  });

  test("the AI SDK parses it back into the same tool call", async () => {
    const provider = await startProvider({ scenario: SCENARIO });
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
    expect(calls[0]?.input).toStrictEqual(EXPECTED_ARGS);
  });

  test("refuses a tool call on a non-streaming request", async () => {
    // 写手要报「不支持」，不能把 SSE 块塞进一个非流式响应里（ADR-0011）。
    const provider = await startProvider({
      scenario: { name: "non-stream", rules: [{ toolCall: { name: "x" } }] },
    });

    const { response, text } = await postChatCompletions(provider.baseURL, {
      stream: false,
    });

    expect(response.status).toBe(500);
    expect(text).toContain("toolCall rule needs a streaming request");
  });
});
