import { describe, expect, test } from "vitest";

import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  estimateTokens,
} from "../../src/compaction/estimate.js";

/** A PNG header that declares one size; the parser reads the first 24 bytes. */
function pngHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(29);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes.toString("base64");
}

/**
 * A JPEG header whose frame marker sits past the first 32 bytes, the way a camera
 * writes it: 30 bytes of APP0 metadata, then the frame.
 */
function jpegHeader(width: number, height: number, metadataBytes = 30): string {
  const bytes = Buffer.alloc(0x30 + metadataBytes);
  bytes.writeUInt16BE(0xff_d8, 0);
  let offset = 2;
  if (metadataBytes > 0) {
    bytes.writeUInt8(0xff, offset);
    bytes.writeUInt8(0xe0, offset + 1);
    bytes.writeUInt16BE(metadataBytes + 2, offset + 2);
    offset += 2 + metadataBytes + 2;
  }
  bytes.writeUInt8(0xff, offset);
  bytes.writeUInt8(0xc0, offset + 1);
  bytes.writeUInt16BE(0x11, offset + 2);
  bytes.writeUInt8(8, offset + 4);
  bytes.writeUInt16BE(height, offset + 5);
  bytes.writeUInt16BE(width, offset + 7);
  return bytes.toString("base64");
}

function userImageMessage(base64: string) {
  return {
    role: "user" as const,
    content: [
      {
        type: "file" as const,
        mediaType: "image/png",
        data: { type: "data" as const, data: base64 },
      },
    ],
  };
}

/** The price of one image, with the message overhead taken out. */
const imagePrice = (base64: string): number =>
  estimateMessageTokens(userImageMessage(base64)) -
  estimateMessageTokens({ role: "user", content: [] });

/** The token budget of a normalized copy: 1.15 MP, 1536 tokens at P/750. */
const BUDGET_TOKENS = 1536;

describe("token estimates", () => {
  test("uses one ruler for text and JSON", () => {
    expect(estimateTextTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens({ value: "a".repeat(400) })).toBeGreaterThan(100);
  });

  test("prices a small image at one tile", () => {
    expect(imagePrice(pngHeader(64, 64))).toBe(85);
  });

  test("prices an image by its pixels", () => {
    expect(imagePrice(pngHeader(600, 400))).toBe(320);
  });

  test("prices a full copy at the pixel budget of a normalized image", () => {
    expect(imagePrice(pngHeader(1536, 750))).toBe(BUDGET_TOKENS);
  });

  test("prices an oversized image at the same ceiling", () => {
    expect(imagePrice(pngHeader(4000, 4000))).toBe(BUDGET_TOKENS);
  });

  test("reads the size of a JPEG whose frame header sits behind its metadata", () => {
    expect(imagePrice(jpegHeader(600, 400))).toBe(320);
  });

  test("prices a head with no size at the ceiling", () => {
    expect(imagePrice(Buffer.from("not an image").toString("base64"))).toBe(
      BUDGET_TOKENS
    );
    expect(imagePrice("")).toBe(BUDGET_TOKENS);
  });

  test("prices a history that holds a tiny image and a full one differently", () => {
    const history = [
      userImageMessage(pngHeader(1, 1)),
      userImageMessage(pngHeader(1536, 750)),
    ];

    const [tiny, full] = history.map((message) =>
      estimateMessageTokens(message)
    );

    expect(tiny).toBe(85 + 4);
    expect(full).toBe(BUDGET_TOKENS + 4);
  });

  test("prices an image URL at the ceiling", () => {
    const message = {
      role: "user" as const,
      content: [
        {
          type: "file" as const,
          mediaType: "image/png",
          data: {
            type: "url" as const,
            url: new URL("https://example.com/a.png"),
          },
        },
      ],
    };

    expect(estimateMessageTokens(message)).toBe(BUDGET_TOKENS + 4);
  });

  test("prices the image in a tool result by its pixels", () => {
    const message = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "call-1",
          toolName: "read-file",
          output: {
            type: "content" as const,
            value: [
              { type: "text" as const, text: "<path>a.png</path>" },
              {
                type: "file" as const,
                data: { type: "data" as const, data: pngHeader(600, 400) },
                mediaType: "image/png",
              },
            ],
          },
        },
      ],
    };

    // The envelope is five tokens, the image is 320, the tool call adds eight, and the
    // message adds four.
    expect(estimateMessageTokens(message)).toBe(5 + 320 + 8 + 4);
  });

  test("keeps a non-image file at its flat price", () => {
    const message = {
      role: "user" as const,
      content: [
        {
          type: "file" as const,
          mediaType: "application/pdf",
          data: { type: "data" as const, data: "AAAA" },
        },
      ],
    };

    expect(estimateMessageTokens(message)).toBe(200 + 4);
  });

  test("sums messages", () => {
    const messages = [
      { role: "user" as const, content: "a".repeat(400) },
      { role: "assistant" as const, content: "b".repeat(400) },
    ];
    expect(estimateMessagesTokens(messages)).toBe(
      estimateMessageTokens(messages[0]!) + estimateMessageTokens(messages[1]!)
    );
  });
});
