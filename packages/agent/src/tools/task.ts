import { findToolPartByToolCallId } from "@workspace/agent-client";
import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type {
  SubagentFactory,
  TranscriptReader,
} from "../extensions/capabilities";
import { DEFAULT_SUBAGENT_NAME } from "../subagent/definitions";
import type { SubagentDefinition } from "../subagent/definitions";
import type { ToolOutput } from "./types";

export type TaskToolRuntime = {
  transcript: TranscriptReader;
  subagents: SubagentFactory;
  definitions: readonly SubagentDefinition[];
};

type TaskToolInput = {
  subagent_type: string;
  description: string;
  prompt: string;
};

type TaskToolMetadata = {
  status: string;
  /**
   * The session the subagent runs in, so a client holding this call can read
   * the transcript behind it. It travels on the result rather than being looked
   * up because the id is generated here and nothing in the parent's transcript
   * names it.
   */
  sessionId?: string;
};

type TaskToolOutput = ToolOutput<string, TaskToolMetadata>;

/**
 * Delegates one piece of work to a subagent.
 *
 * The call is the subagent's home: its transcript is folded into this part, an
 * answer to one of its questions is routed back through this part, and a
 * resumed call reads the transcript off it rather than starting over.
 *
 * It is the one tool here that streams: a call takes as long as the subagent
 * does, so it reports the session it started as soon as there is one to report,
 * and the answer at the end. The first report carries the child's session id,
 * which is what lets a client read that session while this call is still
 * running; the second carries it again, because a transcript keeps only the
 * final result and a reloaded page still has to find the child.
 */
export const createTaskTool = ({
  transcript,
  subagents,
  definitions,
}: TaskToolRuntime): Tool<TaskToolInput, TaskToolOutput, AgentContext> => {
  const names = definitions.map((definition) => definition.name).join(", ");

  const resolveDefinition = (name: string): SubagentDefinition | undefined =>
    definitions.find((definition) => definition.name === name) ??
    definitions.find((definition) => definition.name === DEFAULT_SUBAGENT_NAME);

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
        "A short (5-10 words) description of the task, shown to the user."
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
    // A generator, because the run has two things to say. Only what it yields
    // is ever seen: the runner takes the last yielded value as the call's
    // result and drops a generator's return value, so every way out of this
    // call — including the failures below — has to yield.
    async *execute(
      { subagent_type, description: label, prompt },
      { toolCallId }
    ) {
      const definition = resolveDefinition(subagent_type);

      if (!definition) {
        yield {
          output: `No subagent named "${subagent_type}". Available: ${names}.`,
          code: "error",
          metadata: {
            status: "error",
          },
        };
        return;
      }

      // The part carries whatever an earlier run of this call produced. Absent
      // on a first run; on a resumed one it is the transcript to carry on from.
      // The turn and step it sits in are where its events are published.
      const location = findToolPartByToolCallId(
        [...transcript.turns()],
        toolCallId
      );

      if (!location) {
        // The call is not in the transcript the parent handed over, so there is
        // nowhere for the subagent's events to go. Answering the model is the
        // only useful thing left to do.
        yield {
          output: `The ${definition.name} subagent could not be started: its call is not in the transcript.`,
          code: "error",
          metadata: {
            status: "error",
          },
        };
        return;
      }

      const run = await subagents.start({
        definition,
        prompt,
        description: label,
        toolCallId,
      });

      // 到这里子会话才是真的能读：行、activeStream 和流都写好了。id 就是
      // 在这一刻报出去的，所以客户端拿到它去读时读到的不是空会话，也不必
      // 反复回来问"建好了没"。
      yield {
        output: "",
        code: "ok",
        metadata: {
          status: "running",
          sessionId: run.sessionId,
        },
      };

      // The call does not return until the subagent has ended, because what the
      // parent's next step does with this answer is read it: handing it a
      // half-written one would be handing it nothing to act on.
      const { report, status } = await run.wait();

      yield {
        output:
          report ||
          `The ${definition.name} subagent finished without a report.`,
        code: status === "done" ? "ok" : "error",
        metadata: {
          status,
          sessionId: run.sessionId,
        },
      };
    },
  });
};

export type TaskToolType = ReturnType<typeof createTaskTool>;
