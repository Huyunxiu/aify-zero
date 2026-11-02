import { describe, expect, test } from "vitest";

import { encodeChannelMessage, parseChannelMessage } from "../src/ws-protocol";

describe("channel protocol", () => {
  test("encodes a message without data as type only", () => {
    expect(encodeChannelMessage({ type: "hello" })).toBe('{"type":"hello"}');
  });

  test("parses a message without data", () => {
    expect(parseChannelMessage('{"type":"world"}')).toStrictEqual({
      type: "world",
    });
  });

  test("keeps the data payload", () => {
    expect(
      parseChannelMessage('{"type":"world","data":{"ok":true}}')
    ).toStrictEqual({ data: { ok: true }, type: "world" });
  });

  test("rejects a message that is not JSON", () => {
    expect(() => parseChannelMessage("hello")).toThrow(/not JSON/);
  });

  test("rejects a message that is not an object", () => {
    expect(() => parseChannelMessage('["hello"]')).toThrow(/JSON object/);
  });

  test("rejects a message without a type", () => {
    expect(() => parseChannelMessage('{"data":1}')).toThrow(/type/);
  });

  test("rejects a field outside type and data", () => {
    expect(() => parseChannelMessage('{"type":"hello","extra":1}')).toThrow(
      /unexpected message field/
    );
  });
});
