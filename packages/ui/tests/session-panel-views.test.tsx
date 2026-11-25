import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { PanelTab } from "../src/blocks/session-panel/tabs";
import { describeTab } from "../src/blocks/session-panel/views";
import { i18n } from "../src/i18n";

/** A subagent tab; the title is absent when the record cannot name the call. */
const subagentTab = (title?: string): PanelTab => ({
  files: null,
  id: "agent",
  subagent: {
    sessionId: "child-1",
    ...(title === undefined ? {} : { title }),
  },
  view: "subagent",
});

describe("a subagent tab", () => {
  test("is named after the call that started the subagent", () => {
    expect(describeTab(subagentTab("Explore the parser"), i18n.t).label).toBe(
      "Explore the parser"
    );
  });

  test("falls back to the name of its view when no record names it", () => {
    expect(describeTab(subagentTab(), i18n.t).label).toBe("Subagent");
  });

  test("draws an icon", () => {
    const { icon } = describeTab(subagentTab("Explore the parser"), i18n.t);

    expect(renderToStaticMarkup(createElement(Fragment, null, icon))).not.toBe(
      ""
    );
  });
});
