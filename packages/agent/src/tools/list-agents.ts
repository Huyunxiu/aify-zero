import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { Subagents, SubagentSummary } from "../extensions/capabilities";
import type { ToolOutput } from "./types";

export type ListAgentsToolRuntime = {
  subagents: Subagents;
};

type ListAgentsMetadata = {
  running: number;
  limit: number;
  agents: readonly SubagentSummary[];
};

type ListAgentsOutput = ToolOutput<string, ListAgentsMetadata>;

/** One row as the model reads it: the name first, because the name is the address. */
const describeAgent = (agent: SubagentSummary): string => {
  const age =
    agent.runningMs === undefined
      ? ""
      : ` for ${String(Math.max(1, Math.round(agent.runningMs / 60_000)))}m`;

  return `- ${agent.name} (${agent.subagentType}) ${agent.status}${age}`;
};

/**
 * Lists the subagents this session holds, running or reported.
 *
 * It is the one place that reports a run's age, which is how a parent notices a
 * subagent that has stopped making progress without being told about it.
 */
export const createListAgentsTool = ({
  subagents,
}: ListAgentsToolRuntime): Tool<
  Record<string, never>,
  ListAgentsOutput,
  AgentContext
> =>
  tool<Record<string, never>, ListAgentsOutput, AgentContext>({
    description:
      "List the subagents this session started, with their names, types, and status. It is not a way to wait for one: a subagent reports by itself, so check this list only when you need to know what is still out.",
    inputSchema: z.object({}),
    async execute() {
      const list = await subagents.list();
      const metadata = {
        running: list.running,
        limit: list.limit,
        agents: list.subagents,
      };

      if (list.subagents.length === 0) {
        return { output: "No subagents.", code: "ok", metadata };
      }

      return {
        output: [
          `${String(list.running)} of ${String(list.limit)} running.`,
          "",
          ...list.subagents.map(describeAgent),
        ].join("\n"),
        code: "ok",
        metadata,
      };
    },
  });
