import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { Subagents } from "../extensions/capabilities";
import { SubagentNotFoundError } from "../subagent/factory";
import { waitingItems } from "../subagent/notice";
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
  /** Messages the stopped run never read; they are gone. */
  dropped?: number;
};

type StopAgentOutput = ToolOutput<string, StopAgentMetadata>;

/**
 * What the parent reads about one stop.
 *
 * A stop that dropped a message says so in the same sentence: the count is the
 * only sign the parent gets that its sentence will never be read.
 */
const stopText = (name: string, stopped: boolean, dropped: number): string => {
  const head = stopped ? `stopped ${name}` : `${name} was not running`;
  if (dropped === 0) {
    return head;
  }

  // A stop drops the waiting items whether or not a run was live, so the count
  // belongs to both answers: it is the only sign they will not arrive.
  return `${head} and dropped ${waitingItems(dropped)}`;
};

/**
 * Stops the current run of one subagent.
 *
 * The subagent still settles, so its completion notice still arrives: a parent
 * that stopped it should not be left waiting for a bell that will not ring.
 *
 * The items it never read go with the run, and the result says how many. A
 * parent that sent one is told the sentence is gone rather than left to believe
 * it will arrive later.
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
        const { stopped, dropped } = await subagents.stop({ name });

        return {
          output: stopText(name, stopped, dropped),
          code: "ok",
          metadata: { name, stopped, dropped },
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
