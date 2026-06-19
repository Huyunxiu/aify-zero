import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import type { InferUITool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../context";
import type { ToolOutput } from "./types";

const DESCRIPTION = `Write full content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.
- path can be absolute or relative to the current working directory.
- Existing file content will be replaced completely.`;

const fileExists = async (filepath: string): Promise<boolean> => {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
};

const WRITE_FILE_TOOL_INPUT_SCHEMA = z.object({
  content: z
    .string()
    .describe("The full content to write into the target file"),
  path: z
    .string()
    .describe(
      "The absolute path to the file to write (must be absolute, not relative)"
    ),
});

type WriteFileToolInput = z.infer<typeof WRITE_FILE_TOOL_INPUT_SCHEMA>;

type WriteFileToolOutput = ToolOutput;

type CreateWriteFileToolProps = {
  agentContext: AgentContext;
};

const createWriteFileTool = ({ agentContext }: CreateWriteFileToolProps) =>
  tool<WriteFileToolInput, WriteFileToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: WRITE_FILE_TOOL_INPUT_SCHEMA,
    execute: async ({ content, path: filepath }) => {
      const context = agentContext;
      try {
        const absolutePath = path.isAbsolute(filepath)
          ? filepath
          : path.resolve(context.workdir, filepath);
        const existed = await fileExists(absolutePath);
        if (!existed) {
          await mkdir(path.dirname(absolutePath), { recursive: true });
        }
        await writeFile(absolutePath, content, "utf-8");

        const relativePath = path.relative(context.workdir, absolutePath);

        return {
          title: relativePath,
          output: "Wrote file successfully.",
          code: "ok",
        };
      } catch {
        return {
          output: "Write failed.",
          code: "error",
        };
      }
    },
    toModelOutput: ({ output }) => ({
      type: "text",
      value: output.output,
    }),
  });

type WriteFileToolType = InferUITool<ReturnType<typeof createWriteFileTool>>;

export { createWriteFileTool, type WriteFileToolType };
