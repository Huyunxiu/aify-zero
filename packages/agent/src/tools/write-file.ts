import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import type { InferUITool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../context";

const DESCRIPTION = `Write full content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.
- filePath can be absolute or relative to the current working directory.
- Existing file content will be replaced completely.`;

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const createWriteFileTool = () =>
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      content: z
        .string()
        .describe("The full content to write into the target file"),
      filePath: z
        .string()
        .describe(
          "The absolute path to the file to write (must be absolute, not relative)"
        ),
    }),
    execute: async (
      { content, filePath },
      { context: experimental_context }
    ) => {
      const context = experimental_context as AgentContext;
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(context.workdir, filePath);
      const existed = await fileExists(absolutePath);
      if (!existed) {
        await mkdir(path.dirname(absolutePath), { recursive: true });
      }
      await writeFile(absolutePath, content, "utf-8");

      const relativePath = path.relative(context.workdir, absolutePath);

      return {
        title: relativePath,
        output: "Wrote file successfully.",
      };
    },
    toModelOutput: ({ output }) => ({
      type: "text",
      value: output.output,
    }),
  });

type WriteFileToolType = InferUITool<ReturnType<typeof createWriteFileTool>>;

export { createWriteFileTool, type WriteFileToolType };
