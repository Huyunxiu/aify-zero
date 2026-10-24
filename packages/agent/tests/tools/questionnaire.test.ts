import { asSchema } from "@ai-sdk/provider-utils";
import {
  addToolApprovalResponse,
  createQuestionnaireApprovalData,
} from "@workspace/agent-client";
import type { AgentTurn, QuestionnaireAnswers } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import type { Agent } from "../../src/agents.js";
import { createQuestionnaireTool } from "../../src/tools/questionnaire.js";
import type { QuestionnaireToolInput } from "../../src/tools/questionnaire.js";
import type { AgentToolSet } from "../../src/types.js";

type ToolResult = {
  output: string;
  code: "ok" | "error";
  metadata: {
    status: "submitted" | "unanswered";
    total: number;
    answered: number;
    answers: QuestionnaireAnswers;
  };
};

const input: QuestionnaireToolInput = {
  title: "Build plan",
  questions: [
    {
      allowOther: true,
      choices: [
        { label: "This session", value: "session" },
        { label: "The whole project", value: "project" },
      ],
      id: "scope",
      multiple: false,
      prompt: "What should this change cover?",
      required: true,
    },
    {
      allowOther: false,
      choices: [
        { label: "Tests", value: "tests" },
        { label: "Types", value: "types" },
        { label: "Visual QA", value: "visual" },
      ],
      id: "checks",
      multiple: true,
      prompt: "Which checks should pass?",
      required: false,
    },
    {
      allowOther: true,
      id: "notes",
      multiple: false,
      prompt: "Anything else?",
      required: false,
    },
  ],
};

/** A session holding the one questionnaire call the tool is about to execute. */
const heldAgent = (
  data?: ReturnType<typeof createQuestionnaireApprovalData>
): Agent => {
  const turns: AgentTurn<AgentToolSet>[] = [
    {
      id: "turn-1",
      type: "assistant",
      createdAt: 1,
      status: "wait_review",
      content: [
        {
          id: "step-1",
          type: "assistant",
          model: "test-model",
          createdAt: 1,
          status: "done",
          content: [
            {
              type: "tool-questionnaire",
              toolCallId: "call-1",
              rawInput: "",
              state: "approval-requested",
              input,
              approval: { id: "ap-1", createdAt: 1 },
            },
          ],
        },
      ],
    },
  ];

  addToolApprovalResponse(turns, [
    {
      type: "tool.approval-response",
      id: "call-1",
      approvalId: "ap-1",
      approved: true,
      turnId: "turn-1",
      stepId: "step-1",
      createdAt: 2,
      ...(data ? { data } : {}),
    },
  ]);

  return { session: { turns } } as unknown as Agent;
};

const run = async (agent: Agent): Promise<ToolResult> => {
  const questionnaireTool = createQuestionnaireTool({ agent });
  const { execute } = questionnaireTool;

  if (!execute) {
    throw new TypeError("questionnaire tool has no execute function");
  }

  return (await execute(input, {
    toolCallId: "call-1",
  } as never)) as ToolResult;
};

describe(createQuestionnaireTool, () => {
  test("offers a freeform answer when allowOther is omitted", async () => {
    const questionnaireTool = createQuestionnaireTool({ agent: heldAgent() });
    const parsed = await asSchema(questionnaireTool.inputSchema).validate?.({
      questions: [
        {
          id: "scope",
          prompt: "What should this cover?",
          choices: [
            { label: "This session", value: "session" },
            { label: "The whole project", value: "project" },
          ],
        },
      ],
    });

    expect(parsed).toMatchObject({
      success: true,
      value: { questions: [{ allowOther: true }] },
    });
  });

  test("formats the answers and their labels for the model", async () => {
    const result = await run(
      heldAgent(
        createQuestionnaireApprovalData({
          scope: ["session"],
          checks: ["tests", "types"],
          notes: ["keep the diff small"],
        })
      )
    );

    expect(result.code).toBe("ok");
    expect(result.metadata).toStrictEqual({
      status: "submitted",
      title: "Build plan",
      total: 3,
      answered: 3,
      answers: {
        scope: ["session"],
        checks: ["tests", "types"],
        notes: ["keep the diff small"],
      },
    });
    expect(result.output).toContain(
      [
        'The user submitted the questionnaire "Build plan".',
        "1. What should this change cover? -> This session",
        "2. Which checks should pass? -> Tests, Types",
        "3. Anything else? -> keep the diff small",
      ].join("\n")
    );
  });

  test("prefers a freeform answer over a selected choice for a single-choice question", async () => {
    const result = await run(
      heldAgent(
        createQuestionnaireApprovalData({
          scope: ["session", "a different scope"],
          checks: [],
          notes: [],
        })
      )
    );

    expect(result.metadata.answers.scope).toStrictEqual(["a different scope"]);
  });

  test("dedupes a multiple-choice answer and drops unknown values", async () => {
    const result = await run(
      heldAgent(
        createQuestionnaireApprovalData({
          scope: ["session"],
          checks: ["tests", "tests", "unknown"],
          notes: [],
        })
      )
    );

    expect(result.metadata.answers.checks).toStrictEqual(["tests"]);
  });

  test("marks unanswered required questions and skipped optional ones", async () => {
    const result = await run(
      heldAgent(
        createQuestionnaireApprovalData({
          scope: [],
          checks: [],
          notes: [],
        })
      )
    );

    expect(result.metadata.answered).toBe(0);
    expect(result.output).toContain(
      "1. What should this change cover? -> (unanswered)"
    );
    expect(result.output).toContain(
      "2. Which checks should pass? -> (skipped)"
    );
  });

  test("reports an approval that carried no answer data", async () => {
    const result = await run(heldAgent());

    expect(result.code).toBe("error");
    expect(result.metadata).toMatchObject({
      status: "unanswered",
      answered: 0,
      answers: {},
    });
    expect(result.output).toContain("no answers were attached");
  });
});
