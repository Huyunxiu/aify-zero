import type { AsyncIterableStream, TextStreamPart, ToolSet } from "ai";
import { createAsyncIterableStream } from "ai/internal";

import type { AgentStreamPart } from "./types";

/**
 * Maps one `streamText` chunk onto the part the protocol carries, or
 * `undefined` for the chunks the protocol has no part for.
 */
function toAgentPart<TOOLS extends ToolSet>(
  turnId: string,
  stepId: string,
  part: TextStreamPart<TOOLS>
): AgentStreamPart<TOOLS> | undefined {
  switch (part.type) {
    case "text-start": {
      return { ...part, type: "text.start" };
    }
    case "text-delta": {
      return { ...part, type: "text.delta" };
    }
    case "text-end": {
      return { ...part, type: "text.end" };
    }
    case "reasoning-start": {
      return { ...part, type: "reasoning.start" };
    }
    case "reasoning-delta": {
      return { ...part, type: "reasoning.delta" };
    }
    case "reasoning-end": {
      return { ...part, type: "reasoning.end" };
    }
    case "tool-input-start": {
      return { ...part, type: "tool.input-start" };
    }
    case "tool-input-delta": {
      return { ...part, type: "tool.input-delta" };
    }
    case "tool-input-end": {
      return { ...part, type: "tool.input-end" };
    }
    case "tool-call": {
      return { ...part, type: "tool.call" };
    }
    case "tool-result": {
      return { ...part, type: "tool.result" };
    }
    case "tool-error": {
      return { ...part, type: "tool.error" };
    }
    case "tool-output-denied": {
      return { ...part, type: "tool.output-denied" };
    }
    // The model request and response these parts also carry belong to the
    // server: the protocol's step parts take the rest alone.
    case "start-step": {
      return { turnId, stepId, type: "step.start", warnings: part.warnings };
    }
    case "finish-step": {
      const { response: _response, ...step } = part;
      return { ...step, turnId, stepId, type: "step.finish" };
    }
    case "start": {
      return { turnId, stepId, type: "turn.start" };
    }
    case "finish": {
      return { ...part, turnId, stepId, type: "turn.finish" };
    }
    case "abort": {
      return { ...part, type: "abort" };
    }
    case "error": {
      return { ...part, type: "error" };
    }
    // Sources, files, raw provider chunks and tool approvals have no protocol
    // part; dropping them keeps the stream serializable as-is.
    case "custom":
    case "source":
    case "file":
    case "reasoning-file":
    case "tool-approval-request":
    case "tool-approval-response":
    case "raw": {
      console.warn(`toAgentPart unprocessed part: ${JSON.stringify(part)}`);
      return undefined;
    }
    default: {
      console.warn(`toAgentPart unknown part: ${JSON.stringify(part)}`);
      return undefined;
    }
  }
}

/**
 * Converts a `streamText` full stream into the parts of the agent protocol,
 * renaming each chunk's `type` (e.g. `text-delta` to `text.delta`) and dropping
 * the chunks the protocol does not define.
 *
 * Cancelling the returned stream cancels `stream`.
 */
export function toAgentStreamPart<TOOLS extends ToolSet>(
  turnId: string,
  stepId: string,
  stream: AsyncIterableStream<TextStreamPart<TOOLS>>
): AsyncIterableStream<AgentStreamPart<TOOLS>> {
  const transform = new TransformStream<
    TextStreamPart<TOOLS>,
    AgentStreamPart<TOOLS>
  >({
    transform(part, controller) {
      const agentPart = toAgentPart(turnId, stepId, part);
      if (agentPart !== undefined) {
        controller.enqueue(agentPart);
      }
    },
  });

  return createAsyncIterableStream(stream.pipeThrough(transform));
}
