import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { Subagents } from "../extensions/capabilities";
import type { SubagentDefinition } from "../subagent/definitions";
import { SubagentLimitReachedError } from "../subagent/factory";
import type { ToolOutput } from "./types";

export type CreateSubagentToolRuntime = {
  subagents: Subagents;
  definitions: readonly SubagentDefinition[];
};

type CreateSubagentInput = {
  subagent_type: string;
  description: string;
  prompt: string;
};

type CreateSubagentMetadata = {
  status: string;
  /** The name the parent session reaches this subagent by. */
  name?: string;
  /**
   * The session the subagent runs in, so a client holding this call can read the
   * transcript behind it. It travels on the result because nothing else in the
   * parent's transcript names it.
   */
  sessionId?: string;
};

type CreateSubagentOutput = ToolOutput<string, CreateSubagentMetadata>;

/**
 * Starts one subagent and returns at once.
 *
 * It no longer waits for the answer: the subagent's report arrives later as a
 * message of its own, which is what lets the parent do other work while it runs.
 * The name in the result is the only address the parent needs after this call.
 */
export const createCreateSubagentTool = ({
  subagents,
  definitions,
}: CreateSubagentToolRuntime): Tool<
  CreateSubagentInput,
  CreateSubagentOutput,
  AgentContext
> => {
  const names = definitions.map((definition) => definition.name).join(", ");

  const description = `Delegate a self-contained task to a subagent. It works in its own transcript, inside this session's sandbox and session directory. The call returns as soon as the subagent starts; its report arrives later as a message.

Available subagents: ${names}.

- The subagent's intermediate steps stay out of this conversation; only its final report comes back.
- It reads the same project instructions and skills that this session has.`;

  const inputSchema = z.object({
    subagent_type: z
      .string()
      .describe(`Which subagent to run. One of: ${names}.`),
    description: z
      .string()
      .describe(
        "A short (5-10 words) description of the task, shown to the user."
      ),
    prompt: z
      .string()
      .describe(
        "The task for the subagent to carry out, written as a self-contained brief."
      ),
  });

  return tool<CreateSubagentInput, CreateSubagentOutput, AgentContext>({
    description,
    inputSchema,
    async execute(
      { subagent_type, description: label, prompt },
      { toolCallId }
    ) {
      const definition = definitions.find(
        (candidate) => candidate.name === subagent_type
      );

      if (definition === undefined) {
        return {
          output: `No subagent named "${subagent_type}". Available: ${names}.`,
          code: "error",
          metadata: { status: "error" },
        };
      }

      try {
        const created = await subagents.create({
          definition,
          prompt,
          description: label,
          toolCallId,
        });

        return {
          output: `started subagent ${created.name} (${definition.name})`,
          code: "ok",
          metadata: {
            status: "running",
            ...(created.name === null ? {} : { name: created.name }),
            sessionId: created.sessionId,
          },
        };
      } catch (error) {
        if (error instanceof SubagentLimitReachedError) {
          return {
            output: error.message,
            code: "error",
            metadata: { status: "error" },
          };
        }

        throw error;
      }
    },
  });
};
