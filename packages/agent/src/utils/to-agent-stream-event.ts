import type { AsyncIterableStream, TextStreamPart, ToolSet } from "ai";
import { createAsyncIterableStream } from "ai/internal";

import type { AgentStreamEvent } from "../types";

/**
 * Maps one `streamText` chunk onto the part the protocol carries, or
 * `undefined` for the chunks the protocol has no part for.
 */
function toAgentEvent<TOOLS extends ToolSet>(
  turnId: string,
  stepId: string,
  part: TextStreamPart<TOOLS>
): AgentStreamEvent<TOOLS> | undefined {
  const createdAt = Date.now();
  switch (part.type) {
    case "text-start": {
      return { ...part, type: "text.start", turnId, stepId, createdAt };
    }
    case "text-delta": {
      return { ...part, type: "text.delta", turnId, stepId, createdAt };
    }
    case "text-end": {
      return { ...part, type: "text.end", turnId, stepId, createdAt };
    }
    case "reasoning-start": {
      return { ...part, type: "reasoning.start", turnId, stepId, createdAt };
    }
    case "reasoning-delta": {
      return { ...part, type: "reasoning.delta", turnId, stepId, createdAt };
    }
    case "reasoning-end": {
      return { ...part, type: "reasoning.end", turnId, stepId, createdAt };
    }
    case "tool-input-start": {
      return { ...part, type: "tool.input-start", turnId, stepId, createdAt };
    }
    case "tool-input-delta": {
      return { ...part, type: "tool.input-delta", turnId, stepId, createdAt };
    }
    case "tool-input-end": {
      return { ...part, type: "tool.input-end", turnId, stepId, createdAt };
    }
    case "tool-call": {
      return { ...part, type: "tool.call", turnId, stepId, createdAt };
    }
    case "tool-result": {
      return { ...part, type: "tool.result", turnId, stepId, createdAt };
    }
    case "tool-error": {
      return { ...part, type: "tool.error", turnId, stepId, createdAt };
    }
    case "tool-output-denied": {
      return { ...part, type: "tool.output-denied", turnId, stepId, createdAt };
    }
    // The model request and response these parts also carry belong to the
    // server: the protocol's step parts take the rest alone.
    case "start-step": {
      return {
        type: "step.start",
        warnings: part.warnings,
        turnId,
        stepId,
        createdAt,
      };
    }
    case "finish-step": {
      const { response: _response, ...step } = part;
      return { ...step, type: "step.finish", turnId, stepId, createdAt };
    }
    case "start": {
      return { type: "turn.start", turnId, stepId, createdAt };
    }
    case "finish": {
      return { ...part, type: "turn.finish", turnId, stepId, createdAt };
    }
    case "abort": {
      return { ...part, type: "abort", turnId, stepId, createdAt };
    }
    case "error": {
      return { ...part, type: "error", turnId, stepId, createdAt };
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
export function toAgentStreamEvent<TOOLS extends ToolSet>(
  turnId: string,
  stepId: string,
  stream: AsyncIterableStream<TextStreamPart<TOOLS>>
): AsyncIterableStream<AgentStreamEvent<TOOLS>> {
  const transform = new TransformStream<
    TextStreamPart<TOOLS>,
    AgentStreamEvent<TOOLS>
  >({
    transform(part, controller) {
      const agentPart = toAgentEvent(turnId, stepId, part);
      if (agentPart !== undefined) {
        controller.enqueue(agentPart);
      }
    },
  });

  return createAsyncIterableStream(stream.pipeThrough(transform));
}
