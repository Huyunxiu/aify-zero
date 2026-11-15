import { describe, expect, test } from "vitest";

import { matches, RuleBook } from "../../src/testing/fake-provider/rules.js";
import { scenarioSchema } from "../../src/testing/fake-provider/scenario.js";

const rules = (...value: unknown[]) =>
  scenarioSchema.parse({ name: "test", rules: value }).rules;

const issues = (value: unknown): string[] => {
  const parsed = scenarioSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
};

describe(RuleBook, () => {
  test("hands out the rules in file order", () => {
    const book = new RuleBook(rules({ fail: 429 }, { answer: "ok" }));

    expect(book.take({ stream: true })).toStrictEqual({
      kind: "fail",
      fail: 429,
    });
    expect(book.take({ stream: true })).toStrictEqual({
      kind: "answer",
      answer: "ok",
    });
    expect(book.take({ stream: true })).toBeUndefined();
    expect(book.remaining).toBe(0);
  });

  test("keeps a rule that does not match now for a later request", () => {
    // 标题请求先到。它不该消耗给对话准备的那次失败。
    const book = new RuleBook(
      rules(
        { when: { stream: false }, answer: "title" },
        { when: { stream: true }, fail: 503 }
      )
    );

    expect(book.take({ stream: false })).toStrictEqual({
      kind: "answer",
      when: { stream: false },
      answer: "title",
    });
    expect(book.take({ stream: true })).toStrictEqual({
      kind: "fail",
      when: { stream: true },
      fail: 503,
    });
  });

  test("leaves the unmatched rule in the book", () => {
    const book = new RuleBook(
      rules({ when: { stream: true }, fail: 429 }, { answer: "ok" })
    );

    expect(book.take({ stream: false })).toStrictEqual({
      kind: "answer",
      answer: "ok",
    });
    expect(book.remaining).toBe(1);
    expect(book.take({ stream: true })).toStrictEqual({
      kind: "fail",
      when: { stream: true },
      fail: 429,
    });
  });

  test("keeps handing out a replay rule until the recording runs out", () => {
    const book = new RuleBook(rules({ replay: "recorded/one.json" }));

    expect(book.take({ stream: true })).toMatchObject({ kind: "replay" });
    expect(book.take({ stream: true })).toMatchObject({ kind: "replay" });
    expect(book.remaining).toBe(1);
  });

  test("matches on the model too", () => {
    const [rule] = rules({ when: { model: "slow" }, answer: "ok" });
    if (!rule) {
      throw new Error("expected a rule");
    }

    expect(matches(rule, { stream: true, model: "fast" })).toBeFalsy();
    expect(matches(rule, { stream: true, model: "slow" })).toBeTruthy();
  });
});

describe("scenario schema", () => {
  test("refuses a rule with no result", () => {
    expect(
      issues({ name: "test", rules: [{ slow: { chunkMs: 10 } }] })
    ).not.toStrictEqual([]);
  });

  test("refuses a rule with two results", () => {
    expect(
      issues({ name: "test", rules: [{ fail: 429, answer: "also this" }] })
    ).not.toStrictEqual([]);
  });

  test("refuses a modifier that does not belong to the result", () => {
    // `retryAfter` 只对 `fail` 有意义；放到 answer 上必须是错误，不能悄悄丢掉。
    expect(
      issues({ name: "test", rules: [{ answer: "ok", retryAfter: 2 }] })
    ).not.toStrictEqual([]);
  });

  test("refuses a stream error that is not a provider error shape", () => {
    expect(
      issues({
        name: "test",
        rules: [{ failMidStream: { error: "boom" } }],
      })
    ).not.toStrictEqual([]);
  });

  test("refuses an empty rule list", () => {
    expect(issues({ name: "test", rules: [] })).not.toStrictEqual([]);
  });
});
