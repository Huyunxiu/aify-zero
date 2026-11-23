import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentCompactionStep,
  AgentSteeringStep,
  AgentToolSet,
  AgentTurn,
  AgentUserPart,
  AgentUserStep,
  AgentUserTurn,
  StepSource,
} from "@workspace/agent-client";
import {
  JOB_NOTICE_STEP_SOURCE,
  TIMER_STEP_SOURCE,
} from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import {
  buildSessionOutline,
  formatOutlineTime,
} from "../src/lib/session-outline.js";

const textPart = (text: string): AgentUserPart => ({
  type: "text",
  text,
  createdAt: 1,
});

const filePart = (filename?: string): AgentUserPart => ({
  type: "file",
  mediaType: "image/png",
  url: "data:image/png;base64,AA",
  ...(filename ? { filename } : {}),
});

const userTurn = (
  id: string,
  parts: AgentUserPart[],
  createdAt = 1,
  source?: StepSource
): AgentUserTurn => {
  const step: AgentUserStep = {
    id: `${id}-step`,
    type: "user",
    createdAt,
    status: "done",
    content: parts,
    ...(source ? { source } : {}),
  };

  return {
    id,
    type: "user",
    createdAt,
    status: "done",
    content: [step],
  };
};

const textStep = (
  id: string,
  text: string
): AgentAssistantStep<AgentToolSet> => ({
  id,
  type: "assistant",
  model: "test-model",
  createdAt: 1,
  status: "done",
  content: [{ type: "text", text, createdAt: 1 }],
});

const emptyStep = (id: string): AgentAssistantStep<AgentToolSet> => ({
  id,
  type: "assistant",
  model: "test-model",
  createdAt: 1,
  status: "done",
  content: [],
});

const assistantTurn = (
  id: string,
  content: (
    | AgentAssistantStep<AgentToolSet>
    | AgentCompactionStep
    | AgentSteeringStep
  )[]
): AgentAssistantTurn<AgentToolSet> => ({
  id,
  type: "assistant",
  createdAt: 1,
  status: "done",
  content,
});

// 本地时间构造，跨时区跑测试时不会因为 UTC 偏移落到别的日历日上。
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0).getTime();

const NOW = at(2026, 6, 15, 12, 0);

describe(buildSessionOutline, () => {
  test("每个真实提问一节，答复归到最近一次提问", () => {
    const turns: AgentTurn<AgentToolSet>[] = [
      userTurn("q1", [textPart("第一问")]),
      assistantTurn("a1", [textStep("s1", "第一答")]),
      userTurn("q2", [textPart("第二问")]),
      assistantTurn("a2", [textStep("s2", "第二答")]),
    ];

    const sections = buildSessionOutline(turns, NOW, "zh-CN");

    expect(sections.map((section) => section.id)).toStrictEqual(["q1", "q2"]);
    expect(sections.map((section) => section.label)).toStrictEqual([
      "第一问",
      "第二问",
    ]);
    expect(sections.map((section) => section.description)).toStrictEqual([
      "第一答",
      "第二答",
    ]);
  });

  test("完成通知和定时器不是提问，也不切节", () => {
    const turns: AgentTurn<AgentToolSet>[] = [
      userTurn("q1", [textPart("第一问")]),
      userTurn("notice", [textPart("任务完成")], 2, JOB_NOTICE_STEP_SOURCE),
      assistantTurn("a1", [textStep("s1", "第一答")]),
      userTurn("timer", [textPart("到点了")], 3, TIMER_STEP_SOURCE),
      userTurn("q2", [textPart("第二问")]),
    ];

    const sections = buildSessionOutline(turns, NOW, "zh-CN");

    expect(sections.map((section) => section.id)).toStrictEqual(["q1", "q2"]);
    // 系统轮次占锚点，所以第二问的锚点序号不是 1。
    expect(sections.map((section) => section.anchorIndex)).toStrictEqual([
      0, 3,
    ]);
    expect(sections[0]?.description).toBe("第一答");
  });

  test("一节取末条答复里最后一个有文字的步骤", () => {
    const turns: AgentTurn<AgentToolSet>[] = [
      userTurn("q1", [textPart("第一问")]),
      assistantTurn("a1", [
        textStep("s1", "我先看看"),
        emptyStep("s2"),
        textStep("s3", "结论"),
      ]),
    ];

    expect(buildSessionOutline(turns, NOW, "zh-CN")[0]?.description).toBe(
      "结论"
    );
  });

  test("一节的答复取末条 assistant 回合，不是第一条", () => {
    const turns: AgentTurn<AgentToolSet>[] = [
      userTurn("q1", [textPart("第一问")]),
      assistantTurn("a1", [textStep("s1", "旧答复")]),
      assistantTurn("a2", [textStep("s2", "新答复")]),
      userTurn("q2", [textPart("第二问")]),
    ];

    expect(buildSessionOutline(turns, NOW, "zh-CN")[0]?.description).toBe(
      "新答复"
    );
  });

  test("没有文字的答复不占位", () => {
    const turns: AgentTurn<AgentToolSet>[] = [
      userTurn("q1", [textPart("第一问")]),
      assistantTurn("a1", [emptyStep("s1")]),
    ];

    expect(
      buildSessionOutline(turns, NOW, "zh-CN")[0]?.description
    ).toBeUndefined();
  });

  test("只有附件的提问用文件名，没有文件名才用节号", () => {
    const turns: AgentTurn<AgentToolSet>[] = [
      userTurn("q1", [filePart("diagram.png")]),
      userTurn("q2", []),
    ];

    const sections = buildSessionOutline(turns, NOW, "zh-CN");

    expect(sections.map((section) => section.label)).toStrictEqual([
      "diagram.png",
      "#2",
    ]);
  });

  test("标签压成一行并截断", () => {
    const turns: AgentTurn<AgentToolSet>[] = [
      userTurn("q1", [textPart(`a\n\n b   ${"c".repeat(60)}`)]),
    ];

    const label = buildSessionOutline(turns, NOW, "zh-CN")[0]?.label ?? "";

    expect(label).toHaveLength(49);
    expect(label).toBe(`a b ${"c".repeat(44)}…`);
  });
});

describe(formatOutlineTime, () => {
  test("今天只写钟点", () => {
    expect(formatOutlineTime(at(2026, 6, 15, 14, 32), NOW, "zh-CN")).toBe(
      "14:32"
    );
    expect(formatOutlineTime(at(2026, 6, 15, 14, 32), NOW, "en-US")).toBe(
      "2:32 PM"
    );
  });

  test("同一年写日期和钟点", () => {
    expect(formatOutlineTime(at(2026, 11, 20, 14, 32), NOW, "zh-CN")).toBe(
      "11-20 14:32"
    );
    expect(
      formatOutlineTime(at(2026, 11, 20, 14, 32), NOW, "en-US").replace(
        /\s+/g,
        " "
      )
    ).toBe("Nov 20, 2:32 PM");
  });

  test("跨年带上年份", () => {
    expect(formatOutlineTime(at(2025, 12, 30, 14, 32), NOW, "zh-CN")).toBe(
      "2025-12-30 14:32"
    );
    expect(
      formatOutlineTime(at(2025, 12, 30, 14, 32), NOW, "en-US").replace(
        /\s+/g,
        " "
      )
    ).toBe("Dec 30, 2025, 2:32 PM");
  });
});
