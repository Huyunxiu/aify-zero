/**
 * Where a tool result's files go when its protocol will not carry them.
 *
 * A protocol decides the shapes of a request, and one shape differs: the Responses
 * protocol accepts media inside a tool result, and the chat protocol accepts text
 * only. A chat provider given a file in a tool result sends the bytes as text, which
 * the model reads as characters of base64 and never as an image.
 *
 * So the files move to a user message directly after the tool message, which every
 * protocol accepts, and that message names the call they answer: the tool result keeps
 * the sentence it already carried, and that sentence does not say which call a file
 * belongs to when one step read two files.
 *
 * This is a request rule only: the stored history keeps the file in the tool result, as
 * it was recorded, and a later step on the Responses protocol reads it from there.
 *
 * @module
 */

import type { ModelProtocol } from "@workspace/shared/model";
import type { ModelMessage } from "ai";

import type {
  ToolContentPart,
  ToolFilePart,
  ToolValuePart,
} from "./tool-result-content";
import { isToolFilePart } from "./tool-result-content";

type UserContentPart = Exclude<
  Extract<ModelMessage, { role: "user" }>["content"],
  string
>[number];

/** The protocols that accept a file inside a tool result. */
const CARRIES_TOOL_RESULT_FILES: Record<ModelProtocol, boolean> = {
  "openai-responses": true,
  "openai-chat": false,
};

/**
 * The line a tool result keeps where its only content was a file.
 *
 * A result with no content is a part some providers refuse, so the part keeps a
 * sentence instead of nothing.
 */
const LIFTED_FILE_TEXT =
  "The file of this result is in the message that follows.";

/**
 * Move the files of a tool result into a user message when the protocol cannot carry
 * them there.
 *
 * @param messages - the request messages, left untouched.
 * @param protocol - the protocol the request is for.
 * @returns the messages to send: the same array when the protocol carries the files,
 *   or when no result holds one.
 */
export function liftToolResultFiles(
  messages: ModelMessage[],
  protocol: ModelProtocol
): ModelMessage[] {
  if (CARRIES_TOOL_RESULT_FILES[protocol]) {
    return messages;
  }

  const projected: ModelMessage[] = [];
  let changed = false;

  for (const message of messages) {
    if (message.role !== "tool") {
      projected.push(message);
      continue;
    }

    const kept: ToolContentPart[] = [];
    const lifted: UserContentPart[] = [];

    for (const part of message.content) {
      if (part.type !== "tool-result" || part.output.type !== "content") {
        kept.push(part);
        continue;
      }

      const value: ToolValuePart[] = [];
      const files: ToolFilePart[] = [];
      for (const item of part.output.value) {
        if (isToolFilePart(item)) {
          files.push(item);
        } else {
          value.push(item);
        }
      }

      if (files.length === 0) {
        kept.push(part);
        continue;
      }

      changed = true;
      if (value.length === 0) {
        value.push({ type: "text", text: LIFTED_FILE_TEXT });
      }
      kept.push({ ...part, output: { ...part.output, value } });
      lifted.push(
        {
          type: "text",
          text: `Output of the ${part.toolName} call ${part.toolCallId}:`,
        },
        ...files
      );
    }

    if (lifted.length === 0) {
      projected.push(message);
      continue;
    }

    projected.push({ ...message, content: kept });
    projected.push({ role: "user", content: lifted });
  }

  return changed ? projected : messages;
}
