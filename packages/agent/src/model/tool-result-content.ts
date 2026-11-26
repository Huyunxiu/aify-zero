/**
 * The parts of a tool result, and the one test that the request rules share.
 *
 * Two rules read a tool result on its way to a model: one replaces an image the model
 * cannot read, and one moves the files a protocol cannot carry. They must agree on what
 * a file is, or one would move a part the other already replaced. The shapes come from
 * the model message type, so neither rule restates them.
 *
 * @module
 */

import type { ModelMessage } from "ai";

type ToolMessage = Extract<ModelMessage, { role: "tool" }>;

/** One part of a tool message: a result, or an approval response. */
export type ToolContentPart = ToolMessage["content"][number];

/** One tool result. */
export type ToolResultPart = Extract<ToolContentPart, { type: "tool-result" }>;

/** One part of a result that answers with content rather than with text. */
export type ToolValuePart = Extract<
  ToolResultPart["output"],
  { type: "content" }
>["value"][number];

/** A file a tool result carries: the bytes, the media type, and a name. */
export type ToolFilePart = Extract<ToolValuePart, { type: "file" }>;

/**
 * Whether one content part is a file.
 *
 * The test reads the media type rather than the part type: the type field of this
 * union is deprecated, and a media type is the one field only a file part carries.
 * @param part - a part of a tool result's content.
 * @returns true when the part carries bytes.
 */
export function isToolFilePart(part: ToolValuePart): part is ToolFilePart {
  return "mediaType" in part;
}
