import type {
  AgentToolPart,
  AgentToolSet,
  FileReadMetadata,
} from "@workspace/agent-client";

/**
 * What a `read-file` call answers with.
 *
 * A read hands back a file's content, or a description of why it could not: a
 * directory, an attachment, a binary file, a miss. Both of those are the read's
 * own knowledge, so they live here rather than in the panels that draw them.
 */

/**
 * 文件扩展名到 shiki 语言。工具读到的是源码时按源码高亮，读不懂的当纯文本，
 * 和 Markdown 里的围栏代码走同一套高亮器。
 */
const FILE_LANGUAGES: Record<string, string> = {
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  md: "markdown",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

/** 这份文件该按什么语言高亮；认不出扩展名就是纯文本。 */
export const languageFromPath = (path?: string): string => {
  const extension = path?.split(".").pop()?.toLowerCase();

  if (extension === undefined || extension === path) {
    return "text";
  }

  return FILE_LANGUAGES[extension] ?? "text";
};

/**
 * The language to highlight a call's output in.
 *
 * Only a read that answered with a file's content has a language. A directory,
 * an attachment, a binary file, and a miss each answer with a description of
 * what happened, and every tool that is not a read answers with prose.
 */
export const outputLanguageOf = (part: AgentToolPart<AgentToolSet>): string => {
  if (part.type === "tool-read-file") {
    const metadata: FileReadMetadata | undefined = part.output?.metadata;

    if (metadata?.type === "file") {
      return languageFromPath(metadata.filepath);
    }
  }

  return "text";
};

/**
 * Summarizes a file read. `totalLines` is optional, and absent exactly when the
 * byte cap cut the file off before its end was known — so a truncated read with
 * no total says `truncated` rather than inventing a number, and the known-total
 * case says how much of the file is missing without claiming which lines were
 * shown (the read may have been offset into the middle of the file).
 */
export const summarizeFileRead = (
  metadata: FileReadMetadata | undefined
): string | undefined => {
  if (!metadata) {
    return undefined;
  }
  switch (metadata.type) {
    case "file": {
      if (metadata.totalLines === undefined) {
        return metadata.truncated ? "truncated" : undefined;
      }
      return metadata.truncated
        ? `${metadata.totalLines} lines · partial`
        : `${metadata.totalLines} lines`;
    }
    case "directory": {
      return metadata.truncated
        ? `${metadata.entries.length} of ${metadata.totalEntries} entries`
        : `${metadata.totalEntries} entries`;
    }
    case "miss": {
      return "not found";
    }
    case "attachments": {
      return metadata.mime;
    }
    case "binary-file": {
      return "binary file";
    }

    default: {
      return undefined;
    }
  }
};
