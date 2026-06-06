import { describe, expect, test } from "vitest";

import { fn } from "../src/index";

describe("index", () => {
  test("fn", () => {
    expect(fn()).toBe("Hello, @workspace/shared!");
  });
});
