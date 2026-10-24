import type { JSONObject } from "./types";

/**
 * The answers to one questionnaire, keyed by the question id the model wrote.
 *
 * Every question is present, even when the user skipped it: an omitted key and
 * an empty list would otherwise mean the same thing at different layers, and
 * the tool has to be able to say which questions were left unanswered.
 */
export type QuestionnaireAnswers = Record<string, string[]>;

/**
 * The payload an answer carries when the question was a questionnaire.
 *
 * It travels in the approval's `data` rather than `reason`: the reason is the
 * human-readable note the model may see, while this is the application's own
 * structured answer. The agent protocol never interprets it; the questionnaire
 * tool is what reads it back off the held part.
 */
export type QuestionnaireApprovalData = {
  type: "questionnaire-answers";
  answers: QuestionnaireAnswers;
};

const QUESTIONNAIRE_APPROVAL_DATA_TYPE = "questionnaire-answers";
const QUESTION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u;

/** Bounds mirrored by the tool's input schema, kept here so a hand-written
 * answer cannot put an unbounded payload into the transcript. */
const MAX_ANSWER_KEYS = 64;
const MAX_VALUES_PER_KEY = 20;
const MAX_ANSWER_LENGTH = 2000;

const isJSONObject = (value: unknown): value is JSONObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a question offers a freeform answer.
 *
 * The input schema defaults this to true, but a turn persisted before that
 * default, or a partially streamed input, can omit it. The form and the answer
 * normalizer both read this fallback, so they cannot disagree about whether a
 * written answer is allowed.
 */
export function questionnaireAllowsOther(question: {
  allowOther?: boolean;
}): boolean {
  return question.allowOther ?? true;
}

/**
 * Builds the `data` an answer carries for a questionnaire call.
 *
 * The caller has already collected the values from the form; this only fixes
 * the shape, so the UI and the tool agree on what a submitted questionnaire
 * looks like.
 */
export function createQuestionnaireApprovalData(
  answers: QuestionnaireAnswers
): QuestionnaireApprovalData {
  return {
    type: QUESTIONNAIRE_APPROVAL_DATA_TYPE,
    answers,
  };
}

/**
 * Reads a questionnaire answer back off an approval, or undefined when the
 * payload is not one.
 *
 * The value comes from a client and then from the database, so it is treated as
 * untrusted and bounded before a tool formats it for the model. Empty strings
 * are dropped rather than kept as answers; a key with no values is the shape a
 * skipped question has.
 */
export function readQuestionnaireApprovalData(
  data?: JSONObject
): QuestionnaireAnswers | undefined {
  if (!data || data.type !== QUESTIONNAIRE_APPROVAL_DATA_TYPE) {
    return;
  }

  const rawAnswers = data.answers;

  if (!isJSONObject(rawAnswers)) {
    return;
  }

  const entries = Object.entries(rawAnswers);

  if (entries.length > MAX_ANSWER_KEYS) {
    return;
  }

  const answers: QuestionnaireAnswers = {};

  for (const [questionId, rawValues] of entries) {
    if (!QUESTION_ID_PATTERN.test(questionId)) {
      return;
    }

    if (!Array.isArray(rawValues) || rawValues.length > MAX_VALUES_PER_KEY) {
      return;
    }

    const values: string[] = [];

    for (const rawValue of rawValues) {
      if (typeof rawValue !== "string") {
        return;
      }

      const value = rawValue.trim();

      if (value.length > MAX_ANSWER_LENGTH) {
        return;
      }

      if (value.length > 0) {
        values.push(value);
      }
    }

    answers[questionId] = values;
  }

  return answers;
}
