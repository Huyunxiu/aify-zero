import { describe, expect, test } from "vitest";

import { toolOutputText } from "../src/lib/tool-output-text.js";

describe(toolOutputText, () => {
  test("shows a text result as it is", () => {
    expect(toolOutputText({ output: "echo: hi", code: "ok" })).toBe("echo: hi");
  });

  test("prints a structured result as JSON, so React gets a string", () => {
    // `search-tools` 的 output 是对象。面板原来把它直接交给 React，点了就崩。
    const text = toolOutputText({
      code: "ok",
      output: { results: [{ tool: "echo__echo" }], catalogSize: 1 },
    });

    expect(text).toContain('"results"');
    expect(text).toContain('"catalogSize": 1');
  });

  test("shows nothing when the tool reported no output", () => {
    expect(toolOutputText({ code: "ok" })).toBe("");
    // 还没拿到结果时，part.output 就是没有。
    expect(toolOutputText(null)).toBe("");
  });
});
