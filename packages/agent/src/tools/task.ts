import { findToolPartByToolCallId } from "@workspace/agent-client";
import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { Agent } from "../agents";
import { STREAM_REGISTRY } from "../stream-registry";
import { createSubagent, readSubagentResult } from "../subagent/create";
import {
  DEFAULT_SUBAGENT_NAME,
  getSubagentDefinition,
} from "../subagent/definitions";
import type { SubagentDefinition } from "../subagent/definitions";
import type { ToolOutput } from "./types";

export type TaskToolRuntime = {
  agent: Agent;
  agentContext: AgentContext;
  definitions: readonly SubagentDefinition[];
};

type TaskToolInput = {
  subagent_type: string;
  description: string;
  prompt: string;
};

type TaskToolMetadata = {
  status: string;
};

type TaskToolOutput = ToolOutput<string, TaskToolMetadata>;

/**
 * Delegates one piece of work to a subagent.
 *
 * The call is the subagent's home: its transcript is folded into this part, an
 * answer to one of its questions is routed back through this part, and a
 * resumed call reads the transcript off it rather than starting over.
 */
export const createTaskTool = ({
  agent,
  definitions,
}: TaskToolRuntime): Tool<TaskToolInput, TaskToolOutput, AgentContext> => {
  const names = definitions.map((definition) => definition.name).join(", ");

  const description = `Delegate a self-contained task to a subagent, which runs with its own context and reports back a final answer.

Available subagents: ${names}.

Usage:
- Give the subagent the whole task, not one step of it: it cannot ask you or the user anything.
- The subagent's intermediate steps stay out of this conversation; only its final report comes back.
- State in the prompt what to look at and what the answer should contain.`;

  const inputSchema = z.object({
    subagent_type: z
      .string()
      .describe(`Which subagent to run. One of: ${names}.`),
    description: z
      .string()
      .describe(
        "A short (3-5 word) description of the task, shown to the user."
      ),
    prompt: z
      .string()
      .describe(
        "The task for the subagent to carry out, written as a self-contained brief."
      ),
  });

  return tool<TaskToolInput, TaskToolOutput, AgentContext>({
    description,
    inputSchema,
    execute: async (
      { subagent_type, description: label, prompt },
      { toolCallId }
    ) => {
      const definition =
        getSubagentDefinition(subagent_type) ??
        getSubagentDefinition(DEFAULT_SUBAGENT_NAME);

      if (!definition) {
        return {
          output: `No subagent named "${subagent_type}". Available: ${names}.`,
          code: "error",
          metadata: {
            subagent: subagent_type,
            description: label,
            status: "error",
          },
        };
      }

      // The part carries whatever an earlier run of this call produced. Absent
      // on a first run; on a resumed one it is the transcript to carry on from.
      // The turn and step it sits in are where its events are published.
      const parentTurns = agent.session.turns;
      const location = findToolPartByToolCallId(parentTurns, toolCallId);

      if (!location) {
        // The call is not in the transcript the parent handed over, so there is
        // nowhere for the subagent's events to go. Answering the model is the
        // only useful thing left to do.
        return {
          output: `The ${definition.name} subagent could not be started: its call is not in the transcript.`,
          code: "error",
          metadata: {
            subagent: definition.name,
            description: label,
            status: "error",
          },
        };
      }

      // What the child inherits: the parent's environment, its tools, and its
      // credentials. Not the agent itself — the session and transcript the
      // subagent is meant to be sealed off from live on there.
      const { agent: subagent, turns } = createSubagent(
        {
          context: agent.context,
          tools: agent.tools,
          credentials: {
            apiKey: agent.apiKey,
            apiUrl: agent.apiUrl,
            providerId: agent.providerId,
          },
        },
        { definition, prompt }
      );

      // Registered under the subagent's own session id rather than the
      // parent's, so a reader holding the call can follow the transcript it
      // produced and stopping or reading the parent's session does not walk
      // into it.
      const activeStreamId = subagent.sessionId;

      const stream = await subagent.stream({
        turns,
        modelId: subagent.context.modelId,
        onFinish: () => {
          // The subagent is over, so nothing is left to read from it live; what
          // the parent needs is already in the turns below.
          STREAM_REGISTRY.unregisterStream(activeStreamId);
          return Promise.resolve();
        },
      });

      const entry = STREAM_REGISTRY.registerStream(
        activeStreamId,
        subagent,
        stream
      );

      // The call does not return until the subagent has ended, because what the
      // parent's next step does with this answer is read it: handing it a
      // half-written one would be handing it nothing to act on.
      await entry.whenFinished();

      const { report, status } = readSubagentResult(subagent.session.turns);

      return {
        output:
          report ||
          `The ${definition.name} subagent finished without a report.`,
        code: status === "done" ? "ok" : "error",
        metadata: {
          status,
        },
      };
    },
  });
};

export type TaskToolType = ReturnType<typeof createTaskTool>;
