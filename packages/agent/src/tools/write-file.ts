import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import { resolveToolPath, toolPathDescription } from "../utils/fs-util";
import type { ToolOutput } from "./types";

const DESCRIPTION = `Write full content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.
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
  path: z.string().describe(toolPathDescription("file to write")),
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
      try {
        const { absolute, title } = resolveToolPath(
          filepath,
          agentContext.workdir
        );
        const existed = await fileExists(absolute);
        if (!existed) {
          await mkdir(dirname(absolute), { recursive: true });
        }
        await writeFile(absolute, content, "utf-8");

        return {
          title,
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

type WriteFileToolType = ReturnType<typeof createWriteFileTool>;

export { createWriteFileTool, type WriteFileToolType };
