import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  normalizeToolInputPath,
  resolveToolPath,
} from "../../src/utils/fs-util.js";

const NBSP = String.fromCodePoint(0x00_a0);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x30_00);

describe(normalizeToolInputPath, () => {
  test("should expand a leading tilde", () => {
    expect(normalizeToolInputPath("~")).toBe(homedir());
    expect(normalizeToolInputPath("~/src/a.ts")).toBe(
      join(homedir(), "src/a.ts")
    );
  });

  test("should leave a tilde inside the path alone", () => {
    expect(normalizeToolInputPath("src/~backup")).toBe("src/~backup");
  });

  test("should strip a leading @", () => {
    expect(normalizeToolInputPath("@src/a.ts")).toBe("src/a.ts");
  });

  test("should normalize unicode spaces", () => {
    expect(normalizeToolInputPath(`a${NBSP}b${IDEOGRAPHIC_SPACE}c`)).toBe(
      "a b c"
    );
  });

  test("should convert file URLs to local paths", () => {
    expect(normalizeToolInputPath("file:///tmp/a.ts")).toBe("/tmp/a.ts");
  });

  test("should leave an ordinary path untouched", () => {
    expect(normalizeToolInputPath("src/a.ts")).toBe("src/a.ts");
  });
});

describe(resolveToolPath, () => {
  test("should resolve a relative path against the projectDir", () => {
    expect(resolveToolPath("src/a.ts", "/work").absolute).toBe(
      "/work/src/a.ts"
    );
  });

  test("should use an absolute path as-is", () => {
    expect(resolveToolPath("/work/src/a.ts", "/other").absolute).toBe(
      "/work/src/a.ts"
    );
  });

  test("should expand a tilde before resolving", () => {
    expect(resolveToolPath("~/a.ts", "/work").absolute).toBe(
      join(homedir(), "a.ts")
    );
  });
});
