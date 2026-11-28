import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { Subagents } from "../extensions/capabilities";
import { SubagentNotFoundError } from "../subagent/factory";
import type { ToolOutput } from "./types";

export type SendMessageToolRuntime = {
  subagents: Subagents;
};

type SendMessageInput = {
  name: string;
  text: string;
};

type SendMessageMetadata = {
  name: string;
  handoff?: "started" | "queued";
};

type SendMessageOutput = ToolOutput<string, SendMessageMetadata>;

/**
 * Hands one sentence to a subagent, running or reported.
 *
 * The sentence becomes an inbox item of that subagent. A subagent that is still
 * working takes it at its next step boundary, so it can arrive before the
 * current turn ends; one that has stopped reads it when the run this call starts
 * claims it. The result says which of the two happened, because the parent
 * should not have to guess whether it has to wait.
 */
export const createSendMessageTool = ({
  subagents,
}: SendMessageToolRuntime): Tool<
  SendMessageInput,
  SendMessageOutput,
  AgentContext
> =>
  tool<SendMessageInput, SendMessageOutput, AgentContext>({
    description: `Send a sentence to one of this session's subagents. A subagent that is still running takes it at its next step, so it can land before the current turn ends; one that has reported starts a turn at once.

It reaches only the subagents this session started, by the name create-subagent or list-agents returned.`,
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          "The name of a subagent, as create-subagent or list-agents returned it."
        ),
      text: z.string().describe("The sentence to hand to the subagent."),
    }),
    async execute({ name, text }, { toolCallId }) {
      try {
        const handoff = await subagents.handoff({
          name,
          text,
          // The call id is stable across a retry of the same call, so one call
          // writes one item even when the kernel runs it twice.
          dedupeKey: toolCallId,
        });

        return {
          output:
            handoff === "queued"
              ? `queued for ${name}; it reads this at its next step boundary, or when it runs again`
              : `handed to ${name}; it started a turn`,
          code: "ok",
          metadata: { name, handoff },
        };
      } catch (error) {
        if (error instanceof SubagentNotFoundError) {
          return {
            output: error.message,
            code: "error",
            metadata: { name },
          };
        }

        throw error;
      }
    },
  });
