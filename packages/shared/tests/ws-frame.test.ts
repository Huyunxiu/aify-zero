import { describe, expect, it } from "vitest";

import { frameText } from "../src/ws-frame";

/** 一个字的 UTF-8 字节，三个字节；`Buffer.from` 会落在共享池里，所以自己造。 */
const HAN = Buffer.from(new TextEncoder().encode("好"));

describe("frame text", () => {
  it("passes a string through", () => {
    expect(frameText('{"type":"hello"}')).toBe('{"type":"hello"}');
  });

  it("reads a buffer", () => {
    expect(frameText(HAN)).toBe("好");
  });

  it("reads an array buffer", () => {
    expect(frameText(new TextEncoder().encode("好").buffer)).toBe("好");
  });

  it("joins a fragmented frame before decoding", () => {
    // 分片帧按字节拼起来再解码：先各解一段会在多字节字符中间切断。
    expect(frameText([HAN.subarray(0, 1), HAN.subarray(1)])).toBe("好");
  });
});
