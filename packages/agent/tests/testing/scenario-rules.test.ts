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

    expect(book.take({ stream: true })).toStrictEqual({ fail: 429 });
    expect(book.take({ stream: true })).toStrictEqual({ answer: "ok" });
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
      when: { stream: false },
      answer: "title",
    });
    expect(book.take({ stream: true })).toStrictEqual({
      when: { stream: true },
      fail: 503,
    });
  });

  test("leaves the unmatched rule in the book", () => {
    const book = new RuleBook(
      rules({ when: { stream: true }, fail: 429 }, { answer: "ok" })
    );

    expect(book.take({ stream: false })).toStrictEqual({ answer: "ok" });
    expect(book.remaining).toBe(1);
    expect(book.take({ stream: true })).toStrictEqual({
      when: { stream: true },
      fail: 429,
    });
  });

  test("keeps handing out a replay rule until the recording runs out", () => {
    const book = new RuleBook(rules({ replay: "recorded/one.json" }));

    expect(book.take({ stream: true })?.replay).toBe("recorded/one.json");
    expect(book.take({ stream: true })?.replay).toBe("recorded/one.json");
    expect(book.remaining).toBe(1);
  });

  test("tells two callers apart by what their bodies say", () => {
    // A parent session and its subagent share the model and both stream; the
    // system prompt is the one thing that differs.
    const book = new RuleBook(
      rules(
        {
          when: { bodyContains: "launched by a parent agent" },
          answer: "from the child",
        },
        { answer: "from the parent" }
      )
    );

    expect(
      book.take({
        stream: true,
        body: {
          messages: [
            {
              content:
                "You are a subagent launched by a parent agent to carry out one self-contained task.",
            },
          ],
        },
      })?.answer
    ).toBe("from the child");
    expect(
      book.take({
        stream: true,
        body: { messages: [{ content: "Update the file." }] },
      })?.answer
    ).toBe("from the parent");
  });

  test("matches on the model too", () => {
    expect(
      matches({ when: { model: "slow" } }, { stream: true, model: "fast" })
    ).toBeFalsy();
    expect(
      matches({ when: { model: "slow" } }, { stream: true, model: "slow" })
    ).toBeTruthy();
  });
});

describe("scenario schema", () => {
  test("refuses a rule with no outcome", () => {
    expect(
      issues({ name: "test", rules: [{ slow: { chunkMs: 10 } }] })
    ).toContain(
      "每条规则必须正好有一个结果：answer / fail / failMidStream / replay / reset / corrupt / toolCall"
    );
  });

  test("refuses a rule with two outcomes", () => {
    expect(
      issues({ name: "test", rules: [{ fail: 429, answer: "also this" }] })
    ).toHaveLength(1);
  });

  test("refuses an empty rule list", () => {
    expect(issues({ name: "test", rules: [] })).toHaveLength(1);
  });
});
