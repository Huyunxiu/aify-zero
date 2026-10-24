import {
  findToolPartByToolCallId,
  isAgentToolPart,
  questionnaireAllowsOther,
  readQuestionnaireApprovalData,
} from "@workspace/agent-client";
import type { QuestionnaireAnswers } from "@workspace/agent-client";
import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { Agent } from "../agents";
import type { ToolOutput } from "./types";

const MAX_QUESTIONS = 10;
const MIN_CHOICES = 2;
const MAX_CHOICES = 8;

const QUESTIONNAIRE_CHOICE_SCHEMA = z.object({
  description: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe("Optional supporting line shown under the choice label."),
  label: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The text the user sees for this choice."),
  value: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "The stable value sent back as the answer. Must be unique within the question."
    ),
});

const QUESTIONNAIRE_QUESTION_SCHEMA = z
  .object({
    allowOther: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Offer a freeform input for an answer the choices do not cover. Defaults to true; set false only when the choices are exhaustive by definition."
      ),
    choices: z
      .array(QUESTIONNAIRE_CHOICE_SCHEMA)
      .min(MIN_CHOICES)
      .max(MAX_CHOICES)
      .optional()
      .describe(
        `The fixed choices, when the question has any. ${MIN_CHOICES}-${MAX_CHOICES} choices.`
      ),
    description: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe("Optional supporting line under the question."),
    id: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u)
      .describe(
        "A stable snake_case id, unique in this questionnaire. Answers are keyed by it."
      ),
    multiple: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether the user may select more than one choice."),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("The question the user reads."),
    required: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether the user must answer before moving on."),
  })
  .superRefine((question, context) => {
    if (!question.choices && !question.allowOther) {
      context.addIssue({
        code: "custom",
        message: "Provide choices, allowOther, or both.",
        path: ["choices"],
      });
    }

    if (!question.choices) {
      return;
    }

    const values = new Set<string>();

    for (const [index, choice] of question.choices.entries()) {
      if (values.has(choice.value)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate choice value "${choice.value}".`,
          path: ["choices", index, "value"],
        });
      }
      values.add(choice.value);
    }
  });

const QUESTIONNAIRE_TOOL_INPUT_SCHEMA = z
  .object({
    description: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe("Optional introductory text shown above the questions."),
    questions: z
      .array(QUESTIONNAIRE_QUESTION_SCHEMA)
      .min(1)
      .max(MAX_QUESTIONS)
      .describe(
        `The questions to ask, in order. At least 1, at most ${MAX_QUESTIONS}.`
      ),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional short title for the questionnaire."),
  })
  .superRefine((input, context) => {
    const ids = new Set<string>();

    for (const [index, question] of input.questions.entries()) {
      if (ids.has(question.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate question id "${question.id}".`,
          path: ["questions", index, "id"],
        });
      }
      ids.add(question.id);
    }
  });

export type QuestionnaireToolInput = z.infer<
  typeof QUESTIONNAIRE_TOOL_INPUT_SCHEMA
>;

type QuestionnaireQuestion = QuestionnaireToolInput["questions"][number];

export type QuestionnaireToolMetadata = {
  status: "submitted" | "unanswered";
  title?: string;
  total: number;
  answered: number;
  answers: QuestionnaireAnswers;
};

type QuestionnaireToolOutput = ToolOutput<string, QuestionnaireToolMetadata>;

const DESCRIPTION = [
  "Ask the user one or more questions and wait for their answers.",
  "",
  "Use this when a decision depends on the user's preference or on context you cannot infer from the repository. The user sees a form; the turn waits until they submit answers, skip optional questions, or decline.",
  "",
  "Guidelines:",
  "- Ask only what you cannot find out yourself, and keep the set focused (1-5 questions).",
  "- Give each question a stable snake_case id; answers are keyed by it.",
  `- Provide ${MIN_CHOICES}-${MAX_CHOICES} choices, or allowOther for a freeform answer, or both.`,
  "- Every question offers a freeform 'Other' answer by default, so the user is never limited to the listed choices. Set allowOther: false only when the choices are exhaustive by definition.",
  "- required: true prevents the user from moving on until that question is answered.",
  "- multiple: true lets the user select more than one choice.",
  "- Do not call this tool in parallel with other tools: the whole step waits for the user.",
].join("\n");

const answerLabel = (question: QuestionnaireQuestion, value: string): string =>
  question.choices?.find((choice) => choice.value === value)?.label ?? value;

/**
 * Keeps only answers the question can produce: a value off the choice list is
 * dropped unless the question allows a freeform answer. A single-choice
 * question also keeps the freeform value over a selected choice, because that
 * is what "other" means; a multi-choice question keeps every value.
 */
const normalizeAnswers = (
  input: QuestionnaireToolInput,
  raw: QuestionnaireAnswers
): QuestionnaireAnswers => {
  const answers: QuestionnaireAnswers = {};

  for (const question of input.questions) {
    const allowed = new Set(question.choices?.map((choice) => choice.value));
    const values: string[] = [];

    for (const value of raw[question.id] ?? []) {
      if (!questionnaireAllowsOther(question) && !allowed.has(value)) {
        continue;
      }
      if (!values.includes(value)) {
        values.push(value);
      }
    }

    if (question.multiple) {
      answers[question.id] = values;
    } else {
      const freeform = values.find((value) => !allowed.has(value));
      answers[question.id] = freeform ? [freeform] : values.slice(0, 1);
    }
  }

  return answers;
};

const buildResult = (
  input: QuestionnaireToolInput,
  answers: QuestionnaireAnswers
): { output: string; metadata: QuestionnaireToolMetadata } => {
  let answered = 0;
  const lines = [
    input.title
      ? `The user submitted the questionnaire "${input.title}".`
      : "The user submitted the questionnaire.",
  ];

  for (const [index, question] of input.questions.entries()) {
    const values = answers[question.id] ?? [];

    if (values.length > 0) {
      answered += 1;
    }

    const answer =
      values.length > 0
        ? values.map((value) => answerLabel(question, value)).join(", ")
        : question.required
          ? "(unanswered)"
          : "(skipped)";

    lines.push(`${index + 1}. ${question.prompt} -> ${answer}`);
  }

  return {
    output: lines.join("\n"),
    metadata: {
      status: "submitted",
      ...(input.title ? { title: input.title } : {}),
      total: input.questions.length,
      answered,
      answers,
    },
  };
};

type CreateQuestionnaireToolProps = {
  /**
   * The tool reads its own answered part off the session transcript: an
   * approval carries the answer's `data`, but the execution path does not hand
   * it to the tool, and the transcript is where the call and its answer meet.
   */
  agent: Agent;
};

const createQuestionnaireTool = ({
  agent,
}: CreateQuestionnaireToolProps): Tool<
  QuestionnaireToolInput,
  QuestionnaireToolOutput,
  AgentContext
> =>
  tool<QuestionnaireToolInput, QuestionnaireToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: QUESTIONNAIRE_TOOL_INPUT_SCHEMA,
    execute: (input, { toolCallId }) => {
      const location = findToolPartByToolCallId(
        agent.session.turns,
        toolCallId
      );
      const part = location?.part;
      const raw =
        part && isAgentToolPart(part) && part.type === "tool-questionnaire"
          ? readQuestionnaireApprovalData(part.approval?.data)
          : undefined;

      if (!raw) {
        return {
          output:
            "The questionnaire was approved but no answers were attached. Ask the user again if you still need the answers.",
          code: "error",
          metadata: {
            status: "unanswered",
            total: input.questions.length,
            answered: 0,
            answers: {},
          },
        };
      }

      const answers = normalizeAnswers(input, raw);
      const result = buildResult(input, answers);

      return {
        ...result,
        code: "ok",
      };
    },
    toModelOutput({ output }) {
      if (output.code === "error") {
        return { type: "error-text", value: output.output };
      }
      return { type: "text", value: output.output };
    },
  });

type QuestionnaireToolType = ReturnType<typeof createQuestionnaireTool>;

export { createQuestionnaireTool, type QuestionnaireToolType };
