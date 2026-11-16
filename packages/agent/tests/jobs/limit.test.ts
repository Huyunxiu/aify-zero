import { describe, expect, test } from "vitest";

import { fitJobResult, tailBytes, utf8Bytes } from "../../src/jobs/limit.js";

describe(tailBytes, () => {
  test("keeps the last bytes without splitting a multi-byte character", () => {
    const text = "ab你好";
    // “ab你好”共 8 字节；取 7 字节时起点落在 b，不会切坏后面的字符。
    expect(tailBytes(text, 7)).toBe("b你好");
  });

  test("returns short text unchanged", () => {
    expect(tailBytes("abc", 10)).toBe("abc");
  });
});

describe(fitJobResult, () => {
  test("keeps a result under the limit intact", () => {
    expect(
      fitJobResult({
        body: "hello\n",
        suffix: "\n[status: running]",
        limitBytes: 1024,
      })
    ).toStrictEqual({ text: "hello\n\n[status: running]", truncated: false });
  });

  test("keeps the tail and names the full output file", () => {
    const fitted = fitJobResult({
      body: "x".repeat(200),
      suffix: "\n[status: completed]",
      limitBytes: 100,
      spillPath: "/tmp/sessions/s/jobs/bash.log",
    });
    expect(fitted.truncated).toBeTruthy();
    expect(fitted.text).toContain("/tmp/sessions/s/jobs/bash.log");
    expect(fitted.text.endsWith("[status: completed]")).toBeTruthy();
    expect(utf8Bytes(fitted.text)).toBeLessThanOrEqual(100);
  });

  test("says so when no full output file exists", () => {
    const fitted = fitJobResult({
      body: "x".repeat(200),
      suffix: "\n[status: failed]",
      limitBytes: 100,
    });
    expect(fitted.text).toContain("(unavailable)");
  });
});
