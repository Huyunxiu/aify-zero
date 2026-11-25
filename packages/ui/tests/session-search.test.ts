import { describe, expect, test } from "vitest";

import {
  readSubagentId,
  validateSessionSearch,
} from "../src/lib/session-search";

describe("session search", () => {
  test("reads the subagent the panel is showing", () => {
    expect(readSubagentId({ subagent: "child-1" })).toBe("child-1");
  });

  test("no subagent key means none is selected", () => {
    expect(readSubagentId({})).toBeUndefined();
  });

  test("a session address carries exactly three keys", () => {
    expect(
      validateSessionSearch({
        botId: "bot-1",
        projectId: "project-1",
        subagent: "child-1",
        unrelated: "dropped",
      })
    ).toStrictEqual({
      botId: "bot-1",
      projectId: "project-1",
      subagent: "child-1",
    });
  });

  test("an empty address carries three absent keys", () => {
    expect(validateSessionSearch({})).toStrictEqual({
      botId: undefined,
      projectId: undefined,
      subagent: undefined,
    });
  });

  test("an empty or unknown value is not a session", () => {
    expect(readSubagentId({ subagent: "" })).toBeUndefined();
    expect(readSubagentId({ subagent: 42 })).toBeUndefined();
    expect(readSubagentId({ subagent: null })).toBeUndefined();
  });
});
