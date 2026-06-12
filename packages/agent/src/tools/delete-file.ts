import { stat, unlink, rm } from "node:fs/promises";

import { tool } from "ai";
import type { InferUITool } from "ai";
import { z } from "zod";

const DESCRIPTION = `
Delete a file or directory from the local filesystem.

- The path parameter should be an absolute path.
- If the path does not exist, an error is returned.
- For non-empty directories, set \`recursive\` to true to delete its contents recursively.
`;

const createDeleteFileTool = () =>
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      path: z.string().describe("The absolute path to the file or directory to delete"),
      recursive: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, delete directories and their contents recursively. Required for non-empty directories."),
    }),
    execute: async ({ path, recursive }) => {
      const stats = await stat(path);
      if (stats.isDirectory()) {
        await rm(path, { recursive, force: recursive });
      } else {
        await unlink(path);
      }

      return `Deleted ${path}`;
    },
  });

type DeleteFileToolType = InferUITool<ReturnType<typeof createDeleteFileTool>>;

export { createDeleteFileTool, type DeleteFileToolType };
