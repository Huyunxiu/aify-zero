import { describe, expect, test } from "vitest";

import { OutputRing } from "../../src/jobs/ring.js";

describe(OutputRing, () => {
  test("advances absolute offsets by UTF-8 byte length", () => {
    const ring = new OutputRing();
    ring.append("hello", undefined, 1024);
    ring.append("世界", undefined, 1024);

    const read = ring.readFrom(0);

    expect(ring.total).toBe(11);
    expect(read.chunks.map((chunk) => [chunk.at, chunk.text])).toStrictEqual([
      [0, "hello"],
      [5, "世界"],
    ]);
    expect(read.next).toBe(11);
    expect(read.lossy).toBeFalsy();
  });

  test("ignores an empty chunk", () => {
    const ring = new OutputRing();

    expect(ring.append("", undefined, 1024)).toBeFalsy();
    expect(ring.total).toBe(0);
    expect(ring.readFrom(0).chunks).toStrictEqual([]);
  });

  test("drops whole head chunks past the cap", () => {
    const ring = new OutputRing();
    ring.append("aaaa", undefined, 8);
    ring.append("bbbb", undefined, 8);
    ring.append("cccc", undefined, 8);

    expect(ring.total).toBe(12);
    expect(ring.earliest).toBe(4);
    expect(ring.readFrom(0).lossy).toBeTruthy();
    expect(ring.readFrom(4).lossy).toBeFalsy();
    expect(ring.readFrom(4).chunks.map((chunk) => chunk.text)).toStrictEqual([
      "bbbb",
      "cccc",
    ]);
  });

  test("keeps a UTF-8 safe tail for one oversized chunk", () => {
    const ring = new OutputRing();

    // “汉字”共 6 字节；上限 4 字节切在第 2 个字节上，那里是“字”的续字节，
    // 所以尾巴只能从第 3 个字节开始，只留下“字”。
    ring.append("汉字", undefined, 4);

    const read = ring.readFrom(0);
    const [chunk] = read.chunks;

    expect({
      total: ring.total,
      earliest: ring.earliest,
      lossy: read.lossy,
      chunks: read.chunks,
    }).toStrictEqual({
      total: 6,
      earliest: 3,
      lossy: true,
      chunks: [{ at: 3, text: "字", gapBefore: true }],
    });
    expect(chunk?.text).toBe("字");
  });

  test("returns whole chunks that overlap the requested offset", () => {
    const ring = new OutputRing();
    ring.append("hello", undefined, 1024);

    const read = ring.readFrom(2);

    expect(read.chunks.map((chunk) => chunk.text)).toStrictEqual(["hello"]);
    expect(read.chunks[0]?.at).toBe(0);
    expect(read.lossy).toBeFalsy();
  });

  test("reads nothing past the total", () => {
    const ring = new OutputRing();
    ring.append("hello", undefined, 1024);

    const read = ring.readFrom(5);

    expect(read.chunks).toStrictEqual([]);
    expect(read.next).toBe(5);
    expect(read.lossy).toBeFalsy();
  });

  test("keeps the stream label and gap marker", () => {
    const ring = new OutputRing();
    ring.append("out", { channel: "stdout" }, 1024);
    ring.append("err", { channel: "stderr", gapBefore: true }, 1024);

    const read = ring.readFrom(0);

    expect(read.chunks.map((chunk) => chunk.channel)).toStrictEqual([
      "stdout",
      "stderr",
    ]);
    expect(read.chunks[1]?.gapBefore).toBeTruthy();
  });
});
