import { describe, expect, test } from "vitest";

import { relativeTimeBucket } from "../src/lib/relative-time.js";

// 本地时间构造，跨时区跑测试时不会因为 UTC 偏移落到别的日历日上。
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function at(year: number, month: number, day: number, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0).getTime();
}

describe(relativeTimeBucket, () => {
  test("一分钟以内是刚刚，未来的时刻也是刚刚", () => {
    expect(relativeTimeBucket(NOW, NOW, "zh-CN")).toStrictEqual({
      kind: "justNow",
    });
    expect(relativeTimeBucket(NOW - 59 * SECOND, NOW, "zh-CN")).toStrictEqual({
      kind: "justNow",
    });
    expect(relativeTimeBucket(NOW + 5 * MINUTE, NOW, "zh-CN")).toStrictEqual({
      kind: "justNow",
    });
  });

  test("小时以内按分钟向下取整", () => {
    expect(relativeTimeBucket(NOW - MINUTE, NOW, "zh-CN")).toStrictEqual({
      kind: "minutes",
      count: 1,
    });
    expect(relativeTimeBucket(NOW - 59 * MINUTE, NOW, "zh-CN")).toStrictEqual({
      kind: "minutes",
      count: 59,
    });
  });

  test("一天以内按小时向下取整", () => {
    expect(relativeTimeBucket(NOW - HOUR, NOW, "zh-CN")).toStrictEqual({
      kind: "hours",
      count: 1,
    });
    expect(
      relativeTimeBucket(NOW - (23 * HOUR + 59 * MINUTE), NOW, "zh-CN")
    ).toStrictEqual({ kind: "hours", count: 23 });
  });

  test("超过一天按日历日判断，昨天就是昨天那一格", () => {
    // 刚好 24 小时前，仍是昨天的日历日。
    expect(relativeTimeBucket(at(2026, 6, 14), NOW, "zh-CN")).toStrictEqual({
      kind: "yesterday",
    });
    // 26 小时前，也是昨天。
    expect(
      relativeTimeBucket(at(2026, 6, 14, 10, 0), NOW, "zh-CN")
    ).toStrictEqual({ kind: "yesterday" });
    // 36 小时前，已经是前天。
    expect(
      relativeTimeBucket(at(2026, 6, 13, 23, 30), NOW, "zh-CN")
    ).toStrictEqual({ kind: "days", count: 2 });
  });

  test("二到六天按天，七天起改用日期", () => {
    expect(relativeTimeBucket(at(2026, 6, 13), NOW, "zh-CN")).toStrictEqual({
      kind: "days",
      count: 2,
    });
    expect(relativeTimeBucket(at(2026, 6, 9), NOW, "zh-CN")).toStrictEqual({
      kind: "days",
      count: 6,
    });
    expect(relativeTimeBucket(at(2026, 6, 8), NOW, "zh-CN")).toStrictEqual({
      kind: "date",
      text: "06-08",
    });
  });

  test("跨年的日期带上年份", () => {
    expect(relativeTimeBucket(at(2025, 12, 30), NOW, "zh-CN")).toStrictEqual({
      kind: "date",
      text: "2025-12-30",
    });
  });

  test("英文用 Intl 自己的日期写法", () => {
    expect(relativeTimeBucket(at(2026, 6, 8), NOW, "en-US")).toStrictEqual({
      kind: "date",
      text: "Jun 8",
    });
    expect(relativeTimeBucket(at(2025, 12, 30), NOW, "en-US")).toStrictEqual({
      kind: "date",
      text: "Dec 30, 2025",
    });
  });
});
