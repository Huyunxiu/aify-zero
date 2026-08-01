import { createReadStream } from "node:fs";
import { stat, readdir, readFile } from "node:fs/promises";
import { join, isAbsolute, resolve, dirname, basename } from "node:path";
import { createInterface } from "node:readline";

import { tool } from "ai";
import type { InferUITool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../context";
import {
  getFileTypeFromBuffer,
  isBinaryFile,
  normalizePath,
} from "../utils/fs-util";
import type { ToolOutput } from "./types";

const DEFAULT_READ_LIMIT = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const SUPPORTED_ATTACHMENT_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

const DESCRIPTION = `
Load a skill by name or by file path. Skills are reusable prompt templates stored as SKILL.md files.

Usage:
- The skill parameter takes a skill name or id and loads the matching skill.
- Use the path parameter (optional) to load a skill from a specific file path.
- At least one of skill or path must be provided.
- By default, this tool returns up to ${MAX_LINE_LENGTH} lines from the start of the file.
- The offset parameter is the line number to start from (1-indexed).
- To read later sections, call this tool again with a larger offset.
- Contents are returned with each line prefixed by its line number as \`<line>: <content>\`. For example, if a file has contents "foo\n", you will receive "1: foo\n".
- Any line longer than 2000 characters is truncated.
- This tool can read image files and PDFs and return them as file attachments.
`;

async function miss(
  title: string,
  filepath: string
): Promise<LoadSkillToolOutput> {
  const dir = dirname(filepath);
  const base = basename(filepath);
  let items: string[] = [];

  try {
    const entries = await readdir(dir);
    items = entries
      .filter(
        (item) =>
          item.toLowerCase().includes(base.toLowerCase()) ||
          base.toLowerCase().includes(item.toLowerCase())
      )
      .map((item) => join(dir, item))
      .slice(0, 3);
  } catch {
    // directory read failed, no suggestions
  }

  if (items.length > 0) {
    return {
      title,
      output: `File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`,
      code: "error",
      metadata: {
        type: "miss",
        filepath,
      },
    };
  }

  return {
    title,
    output: `File not found: ${filepath}`,
    code: "error",
    metadata: {
      type: "miss",
      filepath,
    },
  };
}

async function readDirectory(
  title: string,
  filepath: string,
  offset: number,
  limit: number
): Promise<LoadSkillToolOutput> {
  const dirents = await readdir(filepath, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      if (dirent.isDirectory()) {
        return `${dirent.name}/`;
      }

      if (dirent.isSymbolicLink()) {
        const target = await stat(join(filepath, dirent.name)).catch(
          () => null
        );
        if (target?.isDirectory()) {
          return `${dirent.name}/`;
        }
      }

      return dirent.name;
    })
  );

  entries.sort((a, b) => a.localeCompare(b));

  const start = offset - 1;
  const sliced = entries.slice(start, start + limit);
  const truncated = start + sliced.length < entries.length;

  const output = [
    `<path>${filepath}</path>`,
    "<type>directory</type>",
    "<entries>",
    sliced.join("\n"),
    truncated
      ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use offset=${offset + sliced.length} to continue.)`
      : `\n(${entries.length} entries)`,
    "</entries>",
  ].join("\n");

  return {
    title,
    output,
    code: "ok",
    metadata: {
      type: "directory",
      filepath,
      truncated,
      entries: sliced,
      limit,
      offset,
      totalEntries: entries.length,
    },
  };
}

async function readAttachments(
  title: string,
  filepath: string,
  mime: string
): Promise<LoadSkillToolOutput> {
  const bytes = await readFile(filepath);
  const output = `File read successfully, mime.types: ${mime}`;
  return {
    title,
    output,
    code: "ok",
    metadata: {
      type: "attachments",
      filepath,
      mime,
    },
    attachments: [
      {
        type: "file-data",
        filename: filepath,
        mediaType: mime,
        data: Buffer.from(bytes).toString("base64"),
      },
    ],
  };
}

function readBinaryFile(
  title: string,
  filepath: string,
  mime: string
): LoadSkillToolOutput {
  const output = `Cannot read binary file: ${filepath}, mime: ${mime}`;
  return {
    title,
    output,
    code: "error",
    metadata: {
      type: "binary-file",
      filepath,
      mime,
    },
  };
}

async function readTextFile(
  title: string,
  filepath: string,
  mime: string,
  offset: number,
  limit: number
): Promise<LoadSkillToolOutput> {
  const stream = createReadStream(filepath, { encoding: "utf-8" });
  const rl = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: stream,
  });

  const start = offset - 1;
  const lines: string[] = [];
  let bytes = 0;
  let totalLines = 0;
  let truncatedByBytes = false;
  let hasMoreLines = false;

  try {
    for await (const rawText of rl) {
      totalLines += 1;
      if (totalLines <= start) {
        continue;
      }

      if (lines.length >= limit) {
        hasMoreLines = true;
        continue;
      }

      const line =
        rawText.length > MAX_LINE_LENGTH
          ? `${rawText.slice(0, MAX_LINE_LENGTH)}${MAX_LINE_SUFFIX}`
          : rawText;
      const size =
        Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0);

      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true;
        hasMoreLines = true;
        break;
      }

      lines.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (totalLines < offset && !(totalLines === 0 && offset === 1)) {
    throw new Error(
      `Offset ${offset} is out of range for this file (${totalLines} lines)`
    );
  }

  const numbered = lines.map((line, index) => `${index + offset}: ${line}`);
  const lastReadLine = offset + lines.length - 1;
  const nextOffset = lastReadLine + 1;
  const output = [
    `<path>${filepath}</path>`,
    "<type>file</type>",
    "<content>",
    numbered.join("\n"),
    truncatedByBytes
      ? `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.)`
      : hasMoreLines
        ? `\n\n(Showing lines ${offset}-${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.)`
        : `\n\n(End of file - total ${totalLines} lines)`,
    "</content>",
  ].join("\n");

  return {
    title,
    output,
    code: "ok",
    metadata: {
      type: "file",
      mime,
      text: lines.join("\n"),
      filepath,
      truncated: truncatedByBytes || hasMoreLines,
      limit,
      offset,
      totalLines,
    },
  };
}

const LOAD_SKILL_TOOL_INPUT_SCHEMA = z.object({
  skill: z.string().describe("Available skill name or id."),
  path: z
    .string()
    .optional()
    .describe("The absolute path to the skill file to read"),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("The maximum number of lines to read (defaults to 2000)"),
  offset: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("The line number to start reading from (1-indexed)"),
});

type LoadSkillToolInput = z.infer<typeof LOAD_SKILL_TOOL_INPUT_SCHEMA>;

type LoadSkillToolOutputMetadata =
  | {
      type: "miss";
      filepath: string;
    }
  | {
      type: "directory";
      filepath: string;
      truncated: boolean;
      entries: string[];
      limit: number;
      offset: number;
      totalEntries: number;
    }
  | {
      type: "file";
      mime: string;
      text: string;
      filepath: string;
      truncated: boolean;
      limit: number;
      offset: number;
      totalLines?: number;
    }
  | {
      type: "attachments";
      filepath: string;
      mime: string;
    }
  | {
      type: "binary-file";
      filepath: string;
      mime: string;
    };

type LoadSkillToolOutput = ToolOutput<string, LoadSkillToolOutputMetadata> & {
  attachments?: {
    type: "file-data";
    /**
     * Base-64 encoded media data.
     */
    data: string;
    /**
     * IANA media type.
     * @see https://www.iana.org/assignments/media-types/media-types.xhtml
     */
    mediaType: string;
    /**
     * Optional filename of the file.
     */
    filename?: string;
  }[];
};

type LoadSkillToolProps = {
  agentContext: AgentContext;
};

const createLoadSkillTool = ({ agentContext }: LoadSkillToolProps) =>
  tool<LoadSkillToolInput, LoadSkillToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: LOAD_SKILL_TOOL_INPUT_SCHEMA,
    execute: async (input) => {
      const context = agentContext;
      const { skill, offset, limit } = input;
      let { path: filepath } = input;

      const normalizedOffset = offset ?? 1;
      const normalizedLimit = limit ?? DEFAULT_READ_LIMIT;

      // Resolve skill by name or id
      let skillContent: string | undefined;
      const skillInfo = agentContext.skills.getByName(skill);
      if (skillInfo) {
        skillContent = skillInfo.content;
        if (!filepath) {
          filepath = skillInfo.location;
        }
      } else {
        const title = skill;
        return {
          title,
          output: `Skill not found: ${skill}`,
          code: "error",
          metadata: {
            type: "miss",
            filepath: skill,
          },
        };
      }

      if (!filepath) {
        return {
          title: "load-skill",
          output: "Either skill name or path must be provided.",
          code: "error",
          metadata: {
            type: "miss",
            filepath: "",
          },
        };
      }

      if (!isAbsolute(filepath)) {
        filepath = resolve(context.workdir, filepath);
      }
      filepath = normalizePath(filepath);
      const title = skill;

      // If skill was resolved by name, return its content directly
      if (skillContent) {
        return {
          title,
          output: skillContent,
          code: "ok",
          metadata: {
            type: "file",
            mime: "text/markdown",
            text: skillContent,
            filepath,
            truncated: false,
            limit: normalizedLimit,
            offset: normalizedOffset,
            totalLines: skillContent.split("\n").length,
          },
        };
      }

      let stats;
      try {
        stats = await stat(filepath);
      } catch {
        return await miss(title, filepath);
      }

      if (stats.isDirectory()) {
        return await readDirectory(
          title,
          filepath,
          normalizedOffset,
          normalizedLimit
        );
      }

      const [mime, ext, sample] = await getFileTypeFromBuffer(
        filepath,
        stats.size
      );

      if (stats.isFile() && mime && SUPPORTED_ATTACHMENT_MIMES.has(mime)) {
        return await readAttachments(title, filepath, mime);
      }

      if (stats.isFile() && ext && isBinaryFile(ext, sample)) {
        return readBinaryFile(title, filepath, mime);
      }

      return await readTextFile(
        title,
        filepath,
        mime,
        normalizedOffset,
        normalizedLimit
      );
    },
    toModelOutput({ output }) {
      if (output.code === "error") {
        return {
          type: "error-text",
          value: output.output,
        };
      }

      if (output.attachments?.length) {
        return {
          type: "content",
          value: output.attachments,
        };
      }

      return {
        type: "text",
        value: output.output,
      };
    },
  });

type LoadSkillToolType = InferUITool<ReturnType<typeof createLoadSkillTool>>;

export { createLoadSkillTool, type LoadSkillToolType };
