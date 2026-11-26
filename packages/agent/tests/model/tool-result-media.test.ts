import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";

import { liftToolResultFiles } from "../../src/model/tool-result-media";

type ToolValue = (
  | { type: "text"; text: string }
  | {
      type: "file";
      data: { type: "data"; data: string };
      mediaType: string;
      filename?: string;
    }
)[];

const image = {
  type: "file" as const,
  data: { type: "data" as const, data: "AAAA" },
  mediaType: "image/png",
  filename: "a.png",
};

function toolMessage(value: ToolValue, toolCallId = "call-1"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "read-file",
        output: { type: "content", value },
      },
    ],
  } as ModelMessage;
}

const valueOf = (message: ModelMessage): unknown[] => {
  const [part] = message.content as {
    output: { value: unknown[] };
  }[];
  if (part === undefined) {
    throw new Error("the tool result should still be there");
  }
  return part.output.value;
};

const filesOf = (message: ModelMessage): unknown[] =>
  (message.content as { type: string; mediaType?: string }[]).filter(
    (part) => part.type === "file"
  );

describe("tool result files", () => {
  test("should move the file to a user message after the result on the chat protocol", () => {
    const messages = [
      toolMessage([{ type: "text", text: "<path>a.png</path>" }, image]),
    ];

    const projected = liftToolResultFiles(messages, "openai-chat");

    expect(projected).toHaveLength(2);
    expect(projected[0]?.role).toBe("tool");
    expect(valueOf(projected[0]!)).toStrictEqual([
      { type: "text", text: "<path>a.png</path>" },
    ]);
    expect(projected[1]?.role).toBe("user");
    expect(filesOf(projected[1]!)).toStrictEqual([image]);
  });

  test("should name the call that the files belong to", () => {
    const projected = liftToolResultFiles(
      [toolMessage([image], "call-42")],
      "openai-chat"
    );

    const [lead] = projected[1]!.content as {
      type: string;
      text?: string;
    }[];
    expect(lead).toStrictEqual({
      type: "text",
      text: "Output of the read-file call call-42:",
    });
  });

  test("should keep a line where the file was, so the result has content", () => {
    const projected = liftToolResultFiles(
      [toolMessage([image])],
      "openai-chat"
    );

    const value = valueOf(projected[0]!);
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({ type: "text" });
    expect((value[0] as { text: string }).text.length).toBeGreaterThan(0);
  });

  test("should keep every result of one step in one user message", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read-file",
            output: {
              type: "content",
              value: [{ type: "text", text: "<path>a.png</path>" }, image],
            },
          },
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "read-file",
            output: {
              type: "content",
              value: [
                { type: "text", text: "<path>b.png</path>" },
                { ...image, filename: "b.png" },
              ],
            },
          },
        ],
      } as ModelMessage,
    ];

    const projected = liftToolResultFiles(messages, "openai-chat");

    expect(projected).toHaveLength(2);
    expect(filesOf(projected[1]!)).toHaveLength(2);
  });

  test("should leave the request alone on the responses protocol", () => {
    const messages = [toolMessage([image])];

    expect(liftToolResultFiles(messages, "openai-responses")).toBe(messages);
  });

  test("should leave a text only result alone", () => {
    const messages = [toolMessage([{ type: "text", text: "plain" }])];

    expect(liftToolResultFiles(messages, "openai-chat")).toBe(messages);
  });

  test("should leave the stored history untouched", () => {
    const messages = [toolMessage([image])];

    liftToolResultFiles(messages, "openai-chat");

    expect(valueOf(messages[0]!)).toHaveLength(1);
  });
});
