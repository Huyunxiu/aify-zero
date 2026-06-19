import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import type { InferUITool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../context";
import { getErrorMessage } from "../utils/error";
import { isBinaryFile, getFileTypeFromBuffer } from "../utils/fs-util";
import type { ToolOutput } from "./types";

class StringNotFoundError extends Error {
  constructor(oldString: string) {
    super(
      `The old_string "${oldString.slice(0, 50)}${oldString.length > 50 ? "..." : ""}" was not found in the file. Ensure you are providing the exact text from the file content.`
    );
    this.name = "StringNotFoundError";
  }
}

class StringNotUniqueError extends Error {
  constructor(oldString: string, count: number) {
    super(
      `The old_string "${oldString.slice(0, 50)}${oldString.length > 50 ? "..." : ""}" appears ${count} times. Provide more context to make it unique, or set replace_all=true.`
    );
    this.name = "StringNotUniqueError";
  }
}

function charRangeToLineRange(
  content: string,
  charStart: number,
  charEnd: number
): { start: number; end: number } | null {
  if (charStart < 0 || charEnd > content.length || charStart > charEnd) {
    return null;
  }

  const lines = content.split("\n");
  let accumulated = 0;
  let startLine = -1;
  let endLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i]?.length ?? 0 + (i < lines.length - 1 ? 1 : 0);

    if (startLine === -1 && accumulated + lineLen > charStart) {
      startLine = i + 1;
    }
    if (accumulated + lineLen > charEnd) {
      endLine = i + 1;
      break;
    }

    accumulated += lineLen;
  }

  if (startLine === -1) {
    startLine = lines.length;
  }
  if (endLine === -1) {
    endLine = lines.length;
  }

  return { start: startLine, end: endLine };
}

function replaceString(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): { content: string; replacements: number } {
  if (replaceAll) {
    const parts = content.split(oldString);
    if (parts.length === 1) {
      throw new StringNotFoundError(oldString);
    }
    return {
      content: parts.join(newString),
      replacements: parts.length - 1,
    };
  }

  const firstIndex = content.indexOf(oldString);
  if (firstIndex === -1) {
    throw new StringNotFoundError(oldString);
  }

  const secondIndex = content.indexOf(oldString, firstIndex + oldString.length);
  if (secondIndex !== -1) {
    throw new StringNotUniqueError(oldString, 2);
  }

  return {
    content:
      content.slice(0, firstIndex) +
      newString +
      content.slice(firstIndex + oldString.length),
    replacements: 1,
  };
}

function getEditedLineRanges(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): string {
  if (!oldString) {
    return "";
  }
  const ranges: string[] = [];
  let position = 0;

  while ((position = content.indexOf(oldString, position)) !== -1) {
    const range = charRangeToLineRange(
      content,
      position,
      position + Math.max(oldString.length, 1)
    );
    if (range) {
      const newLineCount = newString.split("\n").length;
      const end =
        range.start + Math.max(newLineCount, range.end - range.start + 1) - 1;
      ranges.push(
        end === range.start ? String(range.start) : `${range.start}-${end}`
      );
    }
    position += oldString.length;
    if (!replaceAll) {
      break;
    }
  }

  if (ranges.length === 0) {
    return "";
  }
  return ranges.length === 1
    ? ` (lines ${ranges[0]})`
    : ` (lines ${ranges.join(", ")})`;
}

const DESCRIPTION = `
Edit a file by replacing specific text. The old_string must match exactly and be unique in the file.

Usage:
- Read the file first to get the exact text to replace.
- The file content returned by the read tool includes line number prefixes (e.g., "1: content"). Ensure you preserve the exact indentation as it appears AFTER the arrow. Never include any part of the line number prefix in old_string or new_string.
- Include enough surrounding context (multiple lines) to make old_string unique. If it still isn't unique, include more lines.
- Use replace_all only when intentionally replacing all occurrences.
`;

const EDIT_FILE_INPUT_SCHEMA = z.object({
  path: z.string().describe("The absolute path to the file to edit"),
  old_string: z
    .string()
    .describe(
      "The exact text to find and replace. Must be unique in the file."
    ),
  new_string: z.string().describe("The text to replace old_string with"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, replace all occurrences. If false (default), old_string must be unique."
    ),
});

type EditFileInput = z.infer<typeof EDIT_FILE_INPUT_SCHEMA>;

type EditFileOutput = ToolOutput;

type CreateEditFileToolProps = {
  agentContext: AgentContext;
};

const createEditFileTool = ({ agentContext }: CreateEditFileToolProps) =>
  tool<EditFileInput, EditFileOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: EDIT_FILE_INPUT_SCHEMA,
    execute: async ({
      path: filepath,
      old_string,
      new_string,
      replace_all,
    }) => {
      const context = agentContext;
      try {
        const absolutePath = path.isAbsolute(filepath)
          ? filepath
          : path.resolve(context.workdir, filepath);
        const title = path.relative(context.workdir, filepath);

        const stats = await stat(absolutePath);

        const [_, ext, sample] = await getFileTypeFromBuffer(
          absolutePath,
          stats.size
        );

        if (isBinaryFile(ext, sample)) {
          return {
            output: `Cannot edit binary files. Use the write file tool instead.`,
            code: "error",
          };
        }

        const content = await readFile(absolutePath, "utf-8");

        const shouldReplaceAll = replace_all ?? false;

        const lineRanges = getEditedLineRanges(
          content,
          old_string,
          new_string,
          shouldReplaceAll
        );
        const result = replaceString(
          content,
          old_string,
          new_string,
          shouldReplaceAll
        );
        await writeFile(absolutePath, result.content, "utf-8");

        return {
          title,
          output: `Replaced ${result.replacements} occurrence${result.replacements !== 1 ? "s" : ""} in ${absolutePath}${lineRanges}`,
          code: "ok",
        };
      } catch (error) {
        return {
          output: `Edit failed. ${getErrorMessage(error)}`,
          code: "error",
        };
      }
    },
    toModelOutput({ output }) {
      if (output.code === "error") {
        return {
          type: "error-text",
          value: output.output,
        };
      }
      return {
        type: "text",
        value: output.output,
      };
    },
  });

type EditFileToolType = InferUITool<ReturnType<typeof createEditFileTool>>;

export { createEditFileTool, type EditFileToolType };
