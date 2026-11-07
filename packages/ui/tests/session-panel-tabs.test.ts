import { describe, expect, test } from "vitest";

import { withView } from "../src/elements/session-panel/tabs";

describe("panel tab opening", () => {
  test("replaces the new-tab seat", () => {
    expect(withView(["new"], "files")).toStrictEqual(["files"]);
    expect(withView(["new", "terminal"], "files")).toStrictEqual([
      "files",
      "terminal",
    ]);
  });

  test("appends when no seat is free", () => {
    expect(withView(["terminal"], "files")).toStrictEqual([
      "terminal",
      "files",
    ]);
  });

  test("keeps an already open view once", () => {
    expect(withView(["files", "terminal"], "files")).toStrictEqual([
      "files",
      "terminal",
    ]);
  });

  test("does not change the input list", () => {
    const tabs = ["new"] as const;
    const next = withView(tabs, "files");

    expect(tabs).toStrictEqual(["new"]);
    expect(next).not.toBe(tabs);
  });
});
