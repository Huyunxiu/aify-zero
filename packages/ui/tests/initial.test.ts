import { describe, expect, test } from "vitest";

import { initialOf } from "../src/lib/initial";

describe("avatar initial", () => {
  test("takes the first letter of a latin name, upper-cased", () => {
    expect(initialOf("aify")).toBe("A");
  });

  test("takes the first character of a Chinese name", () => {
    expect(initialOf("研究 Bot")).toBe("研");
  });

  test("takes one letter for a name of several words", () => {
    expect(initialOf("Aify Zero")).toBe("A");
  });

  test("keeps an emoji whole", () => {
    expect(initialOf("🐼 研究")).toBe("🐼");
  });

  test("names a placeholder for an empty name", () => {
    expect(initialOf("")).toBe("?");
    expect(initialOf("   ")).toBe("?");
    expect(initialOf(null)).toBe("?");
  });

  test("ignores surrounding whitespace", () => {
    expect(initialOf("  aify  ")).toBe("A");
  });
});
