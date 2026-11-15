import { getErrorMessage } from "@workspace/shared/errors";
import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { ToolEnvironment } from "../extensions/capabilities";
import { toolPathDescription } from "../utils/fs-util";
import type { ToolOutput } from "./types";

const DESCRIPTION = `Write full content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.
- Existing file content will be replaced completely.`;

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
  agentContext: ToolEnvironment;
};

const createWriteFileTool = ({ agentContext }: CreateWriteFileToolProps) =>
  tool<WriteFileToolInput, WriteFileToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: WRITE_FILE_TOOL_INPUT_SCHEMA,
    execute: async ({ content, path: filepath }) => {
      const { sandbox } = agentContext;
      try {
        const absolute = sandbox.resolvePath(filepath);
        const existed = await sandbox.exists(absolute);
        // 沙箱负责建父目录：这是写文件的保证，工具不再自己 mkdir。
        await sandbox.writeFile(absolute, content);

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
      } catch (error) {
        // 失败原因必须让模型看见：策略拒绝和磁盘满都靠这句话区分。
        return {
          output: `Write failed. ${getErrorMessage(error)}`,
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
