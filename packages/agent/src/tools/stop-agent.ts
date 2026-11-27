import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { Subagents } from "../extensions/capabilities";
import { SubagentNotFoundError } from "../subagent/factory";
import type { ToolOutput } from "./types";

export type StopAgentToolRuntime = {
  subagents: Subagents;
};

type StopAgentInput = {
  name: string;
};

type StopAgentMetadata = {
  name: string;
  stopped?: boolean;
};

type StopAgentOutput = ToolOutput<string, StopAgentMetadata>;

/**
 * Stops the current run of one subagent.
 *
 * The subagent still settles, so its completion notice still arrives: a parent
 * that stopped it should not be left waiting for a bell that will not ring.
 */
export const createStopAgentTool = ({
  subagents,
}: StopAgentToolRuntime): Tool<StopAgentInput, StopAgentOutput, AgentContext> =>
  tool<StopAgentInput, StopAgentOutput, AgentContext>({
    description:
      "Stop the current run of one of this session's subagents. It still reports what it reached before it stopped. A subagent that already finished is not running, and this call says so.",
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          "The name of a subagent to stop, as create-subagent or list-agents returned it."
        ),
    }),
    async execute({ name }) {
      try {
        const stopped = await subagents.stop({ name });

        return {
          output: stopped ? `stopped ${name}` : `${name} was not running`,
          code: "ok",
          metadata: { name, stopped },
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
