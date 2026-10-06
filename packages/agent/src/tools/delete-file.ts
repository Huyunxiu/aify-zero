import { stat, unlink, rm } from "node:fs/promises";

import { getErrorMessage } from "@workspace/shared/errors";
import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import { resolveToolPath, toolPathDescription } from "../utils/fs-util";
import type { ToolOutput } from "./types";

const DESCRIPTION = `
Delete a file or directory from the local filesystem.

- If the path does not exist, an error is returned.
- For non-empty directories, set \`recursive\` to true to delete its contents recursively.
`;

const DELETE_FILE_TOOL_INPUT_SCHEMA = z.object({
  path: z.string().describe(toolPathDescription("file or directory to delete")),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, delete directories and their contents recursively. Required for non-empty directories."
    ),
});

type DeleteFileToolInput = z.infer<typeof DELETE_FILE_TOOL_INPUT_SCHEMA>;

type DeleteFileToolOutput = ToolOutput;

type CreateDeleteFileToolProps = {
  agentContext: AgentContext;
};

const createDeleteFileTool = ({ agentContext }: CreateDeleteFileToolProps) =>
  tool<DeleteFileToolInput, DeleteFileToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: DELETE_FILE_TOOL_INPUT_SCHEMA,
    execute: async ({ path: filepath, recursive }) => {
      try {
        const { absolute: absolutePath, title } = resolveToolPath(
          filepath,
          agentContext.workdir
        );

        const stats = await stat(absolutePath);
        if (stats.isDirectory()) {
          await rm(absolutePath, { recursive, force: recursive });
        } else {
          await unlink(absolutePath);
        }

        return {
          title,
          output: `Deleted ${absolutePath}`,
          code: "ok",
        };
      } catch (error) {
        return {
          output: `Delete failed. ${getErrorMessage(error)}`,
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

type DeleteFileToolType = ReturnType<typeof createDeleteFileTool>;

export { createDeleteFileTool, type DeleteFileToolType };
