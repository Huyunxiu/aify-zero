import type { AttachmentRef, FileReadMetadata } from "@workspace/agent-client";
import { EyeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { summarizeTool } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

/** One region fraction as a whole percentage. */
const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * What a `read-file` call answers with.
 *
 * A read hands back a file's content, or a description of why it could not: a
 * directory, an attachment, a binary file, a miss. Both of those are the read's
 * own knowledge, so they live here rather than in the panels that draw them —
 * and a skill that answers with a file read borrows the reading from here.
 */

/**
 * File extensions and the language shiki highlights them in. Source is
 * highlighted as source and anything unrecognized is plain text, through the
 * same highlighter as a fenced code block in Markdown.
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

/** How to highlight this file; an extension it does not know is plain text. */
const languageFromPath = (path?: string): string => {
  const extension = path?.split(".").pop()?.toLowerCase();

  if (extension === undefined || extension === path) {
    return "text";
  }

  return FILE_LANGUAGES[extension] ?? "text";
};

/**
 * The language to highlight a read's output in.
 *
 * Only a read that answered with a file's content has a language. A directory,
 * an attachment, a binary file, and a miss each answer with a description of
 * what happened, and they are prose.
 */
export const outputLanguageOf = (
  part: StepPartOf<"tool-read-file">
): string => {
  const metadata: FileReadMetadata | undefined = part.output?.metadata;

  if (metadata?.type === "file") {
    return languageFromPath(metadata.filepath);
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
      const size =
        metadata.width === undefined || metadata.height === undefined
          ? ""
          : ` · ${metadata.width}×${metadata.height}`;
      const region =
        metadata.region === undefined
          ? ""
          : ` · region ${pct(metadata.region.x)},${pct(metadata.region.y)} ${pct(metadata.region.width)}×${pct(metadata.region.height)}`;
      return `${metadata.mime}${size}${region}`;
    }
    case "binary-file": {
      return "binary file";
    }

    default: {
      return undefined;
    }
  }
};

export const readFileSummary = (
  part: StepPartOf<"tool-read-file">
): ReactNode | undefined =>
  summarizeTool(part, (output) => summarizeFileRead(output.metadata));

/** The address of one stored attachment, for an `<img>` source. */
const attachmentUrl = (attachment: AttachmentRef): string => {
  const url = new URL("api/attachment", document.baseURI);
  url.searchParams.set("owner", attachment.owner);
  url.searchParams.set("sha256", attachment.sha256);
  return url.href;
};

/** The image a read committed, when it committed one. */
const readImage = (
  part: StepPartOf<"tool-read-file">
): AttachmentRef | undefined => {
  if (part.state !== "output-available") {
    return undefined;
  }
  return part.output.attachments?.find(
    (item): item is AttachmentRef => item.type === "attachment"
  );
};

/**
 * The image the model saw, drawn from the stored bytes.
 *
 * The interface could show the text envelope alone, but then a person cannot check
 * what the model answered about: the pixels are the part that matters.
 */
const ReadAttachment = ({ part }: { part: StepPartOf<"tool-read-file"> }) => {
  const image = readImage(part);
  if (image === undefined) {
    return null;
  }
  return (
    <img
      alt={image.name ?? "attachment"}
      className="max-h-80 w-fit rounded border border-border"
      src={attachmentUrl(image)}
    />
  );
};

/** A file the model read: what it was asked for, and what came back. */
export const ReadFileStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-read-file">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title="Read">
        <ReadAttachment part={part} />
        <ToolPanels
          onRespond={onRespond}
          outputLanguage={outputLanguageOf(part)}
          part={part}
        />
      </StepFrame>
    }
    duration={duration}
    icon={<EyeIcon />}
    label={<StepLabel action="Read" detail={part.input?.path} />}
    onRespond={onRespond}
    status={status}
    summary={readFileSummary(part)}
  />
);
