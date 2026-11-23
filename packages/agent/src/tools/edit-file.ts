import { getErrorMessage } from "@workspace/shared/errors";
import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { ToolEnvironment } from "../extensions/capabilities";
import {
  getFileTypeFromSandbox,
  isBinaryFile,
  toolPathDescription,
} from "../utils/fs-util";
import {
  applyEditsToNormalizedContent,
  countLineChanges,
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  splitBom,
} from "./edit-diff";
import { withFileMutationQueue } from "./file-mutation-queue";
import type { ToolOutput } from "./types";

const DESCRIPTION = `
Edit one file with one or more text replacements.

Usage:
- Every edits[].oldText is matched against the original file, before any other edit in the same call is applied. Do not emit overlapping or nested edits; merge nearby changes into one edit.
- A match is exact first. If no exact match is found, the tool compares normalised text instead: line endings as LF, no leading BOM, and quotes or surrounding whitespace may be corrected. The matched lines are then rewritten with your newText.
- Keep oldText as small as possible while it stays unique; add surrounding lines only when needed to disambiguate.
- The read tool prefixes each line with "<line>: ". Never include that prefix in oldText or newText.
- When changing several separate places in one file, send one edit call with several entries in edits[].
- The result reports the diff and the number of lines added and removed.
`;

const EDIT_ENTRY_SCHEMA = z.object({
  oldText: z.string().describe("The text to find and replace."),
  newText: z.string().describe("The text to replace this oldText with"),
});

const EDIT_FILE_INPUT_SCHEMA = z.object({
  path: z.string().describe(toolPathDescription("file to edit")),
  edits: z
    .array(EDIT_ENTRY_SCHEMA)
    .min(1)
    .describe("One or more replacements, applied to the original file."),
});

type EditFileInput = z.infer<typeof EDIT_FILE_INPUT_SCHEMA>;

type EditFileOutputMetadata = {
  filepath: string;
  /** 本次调用替换的文本块数量 */
  replacements: number;
  linesAdded: number;
  linesRemoved: number;
  /** 实际写入后的展示用 diff（带行号） */
  diff: string;
  /** 新文件中第一处改动的行号，用于编辑器跳转 */
  firstChangedLine?: number;
};

type EditFileOutput = ToolOutput<string, EditFileOutputMetadata>;

type CreateEditFileToolProps = {
  agentContext: ToolEnvironment;
};

const createEditFileTool = ({ agentContext }: CreateEditFileToolProps) =>
  tool<EditFileInput, EditFileOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: EDIT_FILE_INPUT_SCHEMA,
    execute: async ({ path: filepath, edits }, { abortSignal }) => {
      const { sandbox } = agentContext;
      try {
        const absolutePath = sandbox.resolvePath(filepath);

        return await withFileMutationQueue(absolutePath, async () => {
          // 每个 await 之后检查一次中断，而不是监听 abort 事件：
          // 事件里直接 reject 会在文件操作尚未结束时提前释放写队列。
          const throwIfAborted = (): void => {
            if (abortSignal?.aborted) {
              throw new Error("Operation aborted");
            }
          };

          throwIfAborted();

          // 直接读：文件不存在、读不了都由 `readFile` 报出真实错误码。先问
          // `exists` 只能得到布尔，猜不出是 ENOENT 还是 EACCES。
          let rawContent: string;
          try {
            rawContent = await sandbox.readFile(absolutePath);
          } catch (error) {
            throwIfAborted();
            const reason =
              error instanceof Error && "code" in error
                ? `Error code: ${String(error.code)}`
                : String(error);
            throw new Error(`Could not edit file: ${filepath}. ${reason}.`, {
              cause: error,
            });
          }
          throwIfAborted();

          const [, ext, sample] = await getFileTypeFromSandbox(
            sandbox,
            absolutePath
          );
          if (isBinaryFile(ext, sample)) {
            throw new Error(
              "Cannot edit binary files. Use the write file tool instead."
            );
          }
          throwIfAborted();

          // 匹配前剥掉 BOM、统一成 LF；写回时再还原，避免改动文件原有编码。
          const { bom, text } = splitBom(rawContent);
          const originalEnding = detectLineEnding(text);
          const normalizedContent = normalizeToLF(text);
          const { baseContent, newContent } = applyEditsToNormalizedContent(
            normalizedContent,
            edits,
            filepath
          );
          throwIfAborted();

          const finalContent =
            bom + restoreLineEndings(newContent, originalEnding);
          await sandbox.writeFile(absolutePath, finalContent);
          throwIfAborted();

          const { linesAdded, linesRemoved } = countLineChanges(
            baseContent,
            newContent
          );
          // 展示用 diff 基于最终内容计算：模糊匹配改写的字符也会如实反映。
          const { diff, firstChangedLine } = generateDiffString(
            baseContent,
            newContent
          );

          const output: EditFileOutput = {
            output: `Successfully replaced ${edits.length} block${edits.length === 1 ? "" : "s"} in ${absolutePath}.`,
            code: "ok",
            metadata: {
              filepath: absolutePath,
              replacements: edits.length,
              linesAdded,
              linesRemoved,
              diff,
              firstChangedLine,
            },
          };
          return output;
        });
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

type EditFileToolType = ReturnType<typeof createEditFileTool>;

export { createEditFileTool, type EditFileToolType };
