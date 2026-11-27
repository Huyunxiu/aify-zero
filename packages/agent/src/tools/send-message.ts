import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { Subagents } from "../extensions/capabilities";
import { SUBAGENT_APPROVAL_REFUSAL } from "../subagent/create";
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
  delivery?: "started" | "queued";
};

type SendMessageOutput = ToolOutput<string, SendMessageMetadata>;

/**
 * Hands one sentence to a subagent, running or reported.
 *
 * A subagent that is still working cannot take a steering word from here — that
 * needs the run's own live turn — so the sentence queues and becomes its next
 * turn. The result says which of the two happened, because the parent should not
 * have to guess whether it has to wait.
 */
export const createSendMessageTool = ({
  subagents,
}: SendMessageToolRuntime): Tool<
  SendMessageInput,
  SendMessageOutput,
  AgentContext
> =>
  tool<SendMessageInput, SendMessageOutput, AgentContext>({
    description: `Send a message to one of this session's subagents. A subagent that is still running reads it as its next turn; one that has reported starts a turn at once.

It reaches only the subagents this session started, by the name create-subagent or list-agents returned. ${SUBAGENT_APPROVAL_REFUSAL}`,
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          "The name of a subagent, as create-subagent or list-agents returned it."
        ),
      text: z.string().describe("The message to deliver to the subagent."),
    }),
    async execute({ name, text }) {
      try {
        const delivery = await subagents.deliver({ name, text });

        return {
          output:
            delivery === "queued"
              ? `queued for ${name}; it reads this after its current turn`
              : `delivered to ${name}; it started a turn`,
          code: "ok",
          metadata: { name, delivery },
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
