import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";

import {
  acceptsInput,
  hideUnsupportedImages,
  inputKindOf,
  ModelInputRefusedError,
} from "../../src/model/input-kinds";

function toolResultMessage(
  value: (
    | { type: "text"; text: string }
    | { type: "file"; data: { type: "data"; data: string }; mediaType: string }
  )[]
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read-file",
        output: { type: "content", value },
      },
    ],
  } as ModelMessage;
}

describe("input kinds", () => {
  test("should map a media type to the kind a route declares", () => {
    expect(inputKindOf("image/png")).toBe("image");
    expect(inputKindOf("text/plain")).toBe("text");
    expect(inputKindOf("application/pdf")).toBe("pdf");
  });

  test("should accept only the kinds the route names", () => {
    expect(acceptsInput(["text"], "text/plain")).toBeTruthy();
    expect(acceptsInput(["text"], "image/png")).toBeFalsy();
    expect(acceptsInput(["text", "image"], "image/webp")).toBeTruthy();
    expect(acceptsInput(["text", "image"], "application/pdf")).toBeFalsy();
  });

  test("should name the path and the fix when a route takes no image", () => {
    const error = new ModelInputRefusedError("/tmp/a.png", "image");

    expect(error.message).toContain('cannot read "/tmp/a.png" as image');
    expect(error.message).toContain("does not accept image input");
    expect(error.kind).toBe("image");
  });

  test("should replace an image with a sentence for a text-only route", () => {
    const messages = [
      toolResultMessage([
        { type: "text", text: "<path>a.png</path>" },
        {
          type: "file",
          data: { type: "data", data: "AAAA" },
          mediaType: "image/png",
        },
      ]),
    ];

    const projected = hideUnsupportedImages(messages, ["text"]);

    const content = projected[0]?.content as { output: { value: unknown[] } }[];
    const [part] = content;
    if (part === undefined) {
      throw new Error("the tool result should still be there");
    }
    expect(part.output.value).toStrictEqual([
      { type: "text", text: "<path>a.png</path>" },
      {
        type: "text",
        text: expect.stringContaining("you did not see its content") as string,
      },
    ]);
  });

  test("should leave the stored history untouched", () => {
    const messages = [
      toolResultMessage([
        {
          type: "file",
          data: { type: "data", data: "AAAA" },
          mediaType: "image/png",
        },
      ]),
    ];

    const projected = hideUnsupportedImages(messages, ["text"]);

    expect(projected).not.toBe(messages);
    const original = messages[0]?.content as { output: { value: unknown[] } }[];
    expect(original[0]?.output.value).toHaveLength(1);
  });

  test("should leave an image alone when the route takes one", () => {
    const messages = [
      toolResultMessage([
        {
          type: "file",
          data: { type: "data", data: "AAAA" },
          mediaType: "image/png",
        },
      ]),
    ];

    expect(hideUnsupportedImages(messages, ["text", "image"])).toBe(messages);
  });

  test("should leave a PDF alone for a route that reads files but not images", () => {
    const messages = [
      toolResultMessage([
        {
          type: "file",
          data: { type: "data", data: "AAAA" },
          mediaType: "application/pdf",
        },
      ]),
    ];

    expect(hideUnsupportedImages(messages, ["text"])).toBe(messages);
  });
});
