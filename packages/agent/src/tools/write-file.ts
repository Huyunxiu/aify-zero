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

type WriteFileToolOutputMetadata = {
  filepath: string;
  created: boolean;
  bytes: number;
  lines: number;
};

type WriteFileToolOutput = ToolOutput<string, WriteFileToolOutputMetadata>;

type CreateWriteFileToolProps = {
  agentContext: AgentContext;
};

const createWriteFileTool = ({ agentContext }: CreateWriteFileToolProps) =>
  tool<WriteFileToolInput, WriteFileToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: WRITE_FILE_TOOL_INPUT_SCHEMA,
    execute: async ({ content, path: filepath }) => {
      try {
        const { absolute } = resolveToolPath(
          filepath,
          agentContext.primaryProjectDir
        );
        const existed = await fileExists(absolute);
        if (!existed) {
          await mkdir(dirname(absolute), { recursive: true });
        }
        await writeFile(absolute, content, "utf-8");

        return {
          output: "Wrote file successfully.",
          code: "ok",
          metadata: {
            filepath: absolute,
            created: !existed,
            bytes: Buffer.byteLength(content, "utf-8"),
            lines: content.length > 0 ? content.split("\n").length : 0,
          },
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
