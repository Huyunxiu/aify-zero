import { describe, expect, test } from "vitest";

import {
  createQuestionnaireApprovalData,
  questionnaireAllowsOther,
  readQuestionnaireApprovalData,
} from "../src/questionnaire";

describe(questionnaireAllowsOther, () => {
  test("treats an omitted flag as allowing a freeform answer", () => {
    expect(questionnaireAllowsOther({})).toBeTruthy();
    expect(questionnaireAllowsOther({ allowOther: true })).toBeTruthy();
    expect(questionnaireAllowsOther({ allowOther: false })).toBeFalsy();
  });
});

describe(createQuestionnaireApprovalData, () => {
  test("builds the payload the questionnaire tool reads", () => {
    expect(
      createQuestionnaireApprovalData({
        scope: ["session"],
        checks: ["tests", "types"],
      })
    ).toStrictEqual({
      type: "questionnaire-answers",
      answers: {
        scope: ["session"],
        checks: ["tests", "types"],
      },
    });
  });
});

describe(readQuestionnaireApprovalData, () => {
  test("round-trips answers and keeps skipped questions as empty lists", () => {
    const data = createQuestionnaireApprovalData({
      scope: ["session"],
      checks: [],
    });

    expect(readQuestionnaireApprovalData(data)).toStrictEqual({
      scope: ["session"],
      checks: [],
    });
  });

  test("trims values and drops blanks", () => {
    expect(
      readQuestionnaireApprovalData({
        type: "questionnaire-answers",
        answers: {
          scope: ["  session  ", "", "   "],
        },
      })
    ).toStrictEqual({
      scope: ["session"],
    });
  });

  test("rejects payloads that are not questionnaire answers", () => {
    expect(readQuestionnaireApprovalData()).toBeUndefined();
    expect(
      readQuestionnaireApprovalData({
        type: "something-else",
        answers: { scope: ["session"] },
      })
    ).toBeUndefined();
    expect(
      readQuestionnaireApprovalData({
        type: "questionnaire-answers",
        answers: "not an object",
      })
    ).toBeUndefined();
  });

  test("rejects answers whose values are not string arrays", () => {
    expect(
      readQuestionnaireApprovalData({
        type: "questionnaire-answers",
        answers: { scope: "session" },
      })
    ).toBeUndefined();
    expect(
      readQuestionnaireApprovalData({
        type: "questionnaire-answers",
        answers: { scope: ["session", 3] },
      })
    ).toBeUndefined();
  });

  test("rejects an answer long enough to make the transcript unbounded", () => {
    expect(
      readQuestionnaireApprovalData({
        type: "questionnaire-answers",
        answers: { scope: ["x".repeat(2001)] },
      })
    ).toBeUndefined();
  });

  test("rejects keys that are not question ids", () => {
    expect(
      readQuestionnaireApprovalData({
        type: "questionnaire-answers",
        answers: JSON.parse('{"__proto__":["polluted"]}'),
      })
    ).toBeUndefined();
    expect(
      readQuestionnaireApprovalData({
        type: "questionnaire-answers",
        answers: { "not an id": ["value"] },
      })
    ).toBeUndefined();
  });
});
