/**
 * The input kinds one model route accepts, and the two consequences of a mismatch.
 *
 * A model route declares which media kinds it takes. A read that produces a kind the
 * route does not take has two outcomes, and they differ on purpose:
 *
 * - At the tool, the model still has a choice, so the read refuses and says which
 *   model would work. Nothing is read, stored, or recorded.
 * - At the request, the bytes come from an older turn that already settled, so the
 *   request replaces them with a sentence instead of stopping the run.
 *
 * One predicate answers both, so the two cannot disagree about what a route takes.
 *
 * @module
 */

import type { ModelMessage } from "ai";

import { unseenImageText } from "../attachments/text";

/** A media kind a model route can declare, as the settings schema spells it. */
export type ModelInputKind = "text" | "image" | "audio" | "video" | "pdf";

/** The kinds a route that declares nothing accepts. */
export const TEXT_ONLY_INPUT_KINDS: readonly ModelInputKind[] = ["text"];

/** The kind a media type belongs to; `application/pdf` is its own kind. */
export function inputKindOf(mediaType: string): string {
  if (mediaType === "application/pdf") {
    return "pdf";
  }
  return mediaType.split("/")[0] ?? mediaType;
}

/** Whether a route that accepts `kinds` accepts one media type. */
export function acceptsInput(
  kinds: readonly string[],
  mediaType: string
): boolean {
  return kinds.includes(inputKindOf(mediaType));
}

/** A read the calling route cannot use, with the sentence that names the fix. */
export class ModelInputRefusedError extends Error {
  readonly kind: string;

  constructor(path: string, kind: string) {
    super(
      `cannot read "${path}" as ${kind}: the current model does not accept ${kind} input. ` +
        `Use a model that declares ${kind} input, or inspect the file another way.`
    );
    this.name = "ModelInputRefusedError";
    this.kind = kind;
  }
}

/**
 * Replace images a route cannot accept with a sentence.
 *
 * Every step calls this because a session can change models, and the history it
 * replays still holds the images an earlier model read. Removing them would make the
 * history claim something it never said; stopping the run would punish a user who
 * only wants to continue in text.
 *
 * The result is a copy, never the history itself: the stored messages are the record,
 * and a model switch back to a route that reads images must find them still there.
 * @param messages - the request messages, left untouched.
 * @param kinds - the kinds the route accepts.
 * @returns the messages to send: the same array when nothing changes.
 */
export function hideUnsupportedImages(
  messages: ModelMessage[],
  kinds: readonly string[]
): ModelMessage[] {
  if (kinds.includes("image")) {
    return messages;
  }
  let changed = false;
  const projected: ModelMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      projected.push(message);
      continue;
    }
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || part.output.type !== "content") {
        return part;
      }
      const value: typeof part.output.value = [];
      for (const item of part.output.value) {
        if (
          !("mediaType" in item) ||
          item.mediaType === undefined ||
          !item.mediaType.startsWith("image/")
        ) {
          value.push(item);
          continue;
        }
        messageChanged = true;
        value.push({
          type: "text",
          text: unseenImageText(
            "filename" in item ? item.filename : undefined,
            item.mediaType
          ),
        });
      }
      return messageChanged
        ? ({ ...part, output: { ...part.output, value } } as typeof part)
        : part;
    });
    if (messageChanged) {
      changed = true;
      projected.push({ ...message, content } as ModelMessage);
      continue;
    }
    projected.push(message);
  }
  return changed ? projected : messages;
}
