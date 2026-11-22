import type { AgentToolPart, AgentToolSet } from "@workspace/agent-client";
import { WrapTextIcon } from "lucide-react";
import * as React from "react";

import type { ToolApprovalAnswer } from "../components/ai-elements/chain-of-turn";
import { Button } from "../components/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "../components/code-block";
import { useHighlightedCode } from "../hooks/use-highlighted-code";
import { toolOutputText } from "../lib/tool-output-text";
import { cn } from "../lib/utils";
import { getPartError } from "./tool-step";

/**
 * A tool call reads twice: what it was asked, and what it answered. Both are
 * code — JSON and raw text — so both are drawn as code blocks instead of as
 * `whitespace-pre` text, which neither wraps nor keeps the monospaced column.
 *
 * Each side is its own card. The frame behind a call carries no surface of its
 * own: these cards are the surface.
 */

/**
 * Tool output runs to thousands of lines. The block scrolls past this height
 * instead of pushing the dialog taller than the window.
 */
const VIEWPORT_HEIGHT = "max-h-[min(20rem,42vh)]";

const EMPTY_TEXT = "Nothing to show";

/** The language tag beside a section title: `json`, `tsx`, `text`. */
const LANGUAGE_CLASS =
  "font-mono text-[10px] leading-none text-muted-foreground/70";

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
export function languageFromPath(path?: string): string {
  const extension = path?.split(".").pop()?.toLowerCase();

  if (extension === undefined || extension === path) {
    return "text";
  }

  return FILE_LANGUAGES[extension] ?? "text";
}

/**
 * Controls that are useful but rarely used — wrapping — stay out of the way
 * until the reader is in the block. Copy stays visible: it is the one control
 * people come looking for.
 */
const HOVER_CONTROL_CLASS =
  "opacity-0 transition-opacity duration-[125ms] ease-out group-hover/section:opacity-100 group-focus-within/section:opacity-100 [@media(hover:none)]:opacity-100";

function ToolCodeBody({
  value,
  language,
  wrap,
  pending,
  className,
  viewportClassName,
}: {
  value: string;
  language: string;
  wrap: boolean;
  pending?: boolean;
  className?: string;
  viewportClassName?: string;
}) {
  const lines = useHighlightedCode(value, language);

  return (
    <CodeBlockContent
      className={className}
      viewportClassName={cn(VIEWPORT_HEIGHT, viewportClassName)}
      wrap={wrap}
    >
      {value.length > 0 ? (
        lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))
      ) : pending ? (
        <ToolPendingLines />
      ) : (
        <span className="text-muted-foreground/70">{EMPTY_TEXT}</span>
      )}
    </CodeBlockContent>
  );
}

/** The JSON is still arriving: three bars say so without a spinner's noise. */
function ToolPendingLines() {
  return (
    <span className="flex flex-col gap-1.5 py-0.5">
      {[64, 40, 52].map((width) => (
        <span
          key={width}
          className="h-2.5 animate-pulse rounded-xs bg-muted-foreground/10 motion-reduce:animate-none"
          style={{ width: `${width}%` }}
        />
      ))}
    </span>
  );
}

function ToolWrapToggle({
  pressed,
  onToggle,
  className,
}: {
  pressed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <Button
      aria-label="Wrap lines"
      aria-pressed={pressed}
      className={cn(
        "text-muted-foreground aria-pressed:text-foreground",
        className
      )}
      onClick={onToggle}
      size="icon-xs"
      variant="ghost"
    >
      <WrapTextIcon />
    </Button>
  );
}

/**
 * One card: title, language, the code, and — when it belongs there — the
 * approval strip under it. Every arrangement builds its sections from this.
 */
export function ToolSection({
  label,
  language,
  value,
  copyValue,
  pending,
  wrap: wrapProp,
  content,
  footer,
  className,
}: {
  label: string;
  language: string;
  value: string;
  /** What the copy button hands over. Defaults to the text shown. */
  copyValue?: string;
  pending?: boolean;
  /** Plain text wraps by default; code keeps its column and scrolls. */
  wrap?: boolean;
  /** Replaces the highlighted text, for content that is already rendered. */
  content?: React.ReactNode;
  /** Pinned under the code, inside the card — the approval strip. */
  footer?: React.ReactNode;
  className?: string;
}) {
  const [wrap, setWrap] = React.useState(wrapProp ?? language === "text");

  return (
    <CodeBlock className={cn("shrink-0 shadow-lg", className)}>
      <CodeBlockHeader className="group/section h-10 gap-2 pr-1.5">
        <CodeBlockTitle>{label}</CodeBlockTitle>
        <span className={LANGUAGE_CLASS}>{language}</span>
        <CodeBlockActions className="gap-1">
          <ToolWrapToggle
            className={HOVER_CONTROL_CLASS}
            onToggle={() => setWrap((previous) => !previous)}
            pressed={wrap}
          />
          <CodeBlockCopyButton
            className="text-muted-foreground/60 hover:text-foreground"
            disabled={value.length === 0}
            value={copyValue ?? value}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      {content ?? (
        <ToolCodeBody
          language={language}
          pending={pending}
          value={value}
          wrap={wrap}
        />
      )}
      {footer}
    </CodeBlock>
  );
}

/** A section whose body is richer than text — markdown, a diff, a table. */
export function ToolRenderedSection({
  label,
  copyValue,
  children,
  footer,
}: {
  label: string;
  copyValue?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <CodeBlock className="shrink-0 shadow-lg">
      <CodeBlockHeader className="group/section h-10 pr-1.5">
        <CodeBlockTitle>{label}</CodeBlockTitle>
        {copyValue === undefined ? null : (
          <CodeBlockActions>
            <CodeBlockCopyButton
              className="text-muted-foreground/60 hover:text-foreground"
              value={copyValue}
            />
          </CodeBlockActions>
        )}
      </CodeBlockHeader>
      <div className="min-w-0 overflow-x-auto p-3 text-sm">{children}</div>
      {footer}
    </CodeBlock>
  );
}

/**
 * The text a call ends with, drawn in the code block's red variant. The label
 * says which end it is: a failure, a refusal, or a decline.
 */
export const ToolErrorSection = ({
  text,
  label = "Error",
}: {
  text: string;
  label?: string;
}) => (
  <CodeBlock variant="destructive" className="shrink-0 shadow-lg">
    <CodeBlockHeader className="group/section h-10 border-destructive/20 bg-destructive/5 pr-1.5">
      <CodeBlockTitle className="text-destructive">{label}</CodeBlockTitle>
      <CodeBlockActions>
        <CodeBlockCopyButton
          className="text-destructive/70 hover:text-destructive"
          value={text}
        />
      </CodeBlockActions>
    </CodeBlockHeader>
    <ToolCodeBody
      language="text"
      value={text}
      viewportClassName="max-h-[min(12rem,28vh)]"
      wrap
    />
  </CodeBlock>
);

type PanelsProps = {
  input: string;
  output: string;
  /** Highlighting for the input block; `json` unless a caller knows better. */
  inputLanguage?: string;
  /** Highlighting for the output block — the language of the file read. */
  outputLanguage?: string;
  pending?: boolean;
  hideOutput?: boolean;
  renderOutput?: (text: string) => React.ReactNode;
  /** Drawn under the input, inside the same card. */
  approval?: React.ReactNode;
  /** Extra sections between the two sides — a diff, a table. */
  children?: React.ReactNode;
  errorText?: string;
  /** What the error block is called; a refusal is not a failure. */
  errorLabel?: string;
};

/**
 * The two ends of a call, one card each.
 *
 * The titles sit in the cards, so a call reads as two blocks of the same kind
 * instead of as a floating label over a white panel.
 */
function ToolPanelsBody({
  input,
  output,
  inputLanguage = "json",
  outputLanguage = "text",
  pending,
  hideOutput,
  renderOutput,
  approval,
  children,
  errorText,
  errorLabel,
}: PanelsProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <ToolSection
        footer={approval}
        label="Input"
        language={inputLanguage}
        pending={pending}
        value={input}
      />
      {children}
      {hideOutput ? null : renderOutput === undefined ? (
        <ToolSection label="Output" language={outputLanguage} value={output} />
      ) : (
        <ToolRenderedSection copyValue={output} label="Output">
          {renderOutput(output)}
        </ToolRenderedSection>
      )}
      {errorText === undefined ? null : (
        <ToolErrorSection label={errorLabel} text={errorText} />
      )}
    </div>
  );
}

/**
 * The language to highlight a call's output in.
 *
 * Only the two calls that hand back a file's contents have one. The other tools
 * answer in prose, so `text` is right for them.
 */
const outputLanguageFor = (part: AgentToolPart): string => {
  if (part.type !== "tool-read-file" && part.type !== "tool-write-file") {
    return "text";
  }

  const input = part.input as { path?: unknown } | undefined;

  return languageFromPath(
    typeof input?.path === "string" ? input.path : undefined
  );
};

/** The approve and deny buttons of a call that is waiting on the user. */
const InlineToolApproval = ({
  part,
  onRespond,
}: {
  part: AgentToolPart;
  onRespond?: (
    approvalId: string,
    approved: boolean,
    answer?: ToolApprovalAnswer
  ) => void;
}) => {
  const { approval } = part;
  if (!approval) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 border-t border-border/70 bg-muted/50 px-2.5 py-2">
      <Button
        variant={approval.approved === true ? "success" : "default"}
        onClick={() => onRespond?.(approval.id, true)}
        size="sm"
      >
        {approval.approved ? "Approved" : "Approve"}
      </Button>
      {approval.approved === undefined && (
        <Button
          onClick={() => onRespond?.(approval.id, false)}
          size="sm"
          variant="outline"
        >
          Deny
        </Button>
      )}
    </div>
  );
};

/**
 * The two ends of a call, from the call itself.
 *
 * The body module knows what a tool's input and output are; the caller only says
 * which part to draw and what sits between the two cards.
 */
export function ToolPanels({
  part,
  onRespond,
  children,
  hideOutput = false,
  renderOutput,
}: {
  part: AgentToolPart;
  onRespond?: (
    approvalId: string,
    approved: boolean,
    answer?: ToolApprovalAnswer
  ) => void;
  /** Drawn between the two cards, for example an edit's diff. */
  children?: React.ReactNode;
  /** No result to show, for example a `task` call that started nothing. */
  hideOutput?: boolean;
  /** Replaces the plain output body when the result needs rich text. */
  renderOutput?: (text: string) => React.ReactNode;
}) {
  const error = getPartError(part);
  // A refused call has no result to show: the reason is drawn under the input,
  // and an empty Output card reads like a result that went missing.
  const refused = part.state === "output-denied";

  return (
    <ToolPanelsBody
      approval={
        part.approval === undefined ? undefined : (
          <InlineToolApproval part={part} onRespond={onRespond} />
        )
      }
      errorLabel={error?.label}
      errorText={error?.text}
      hideOutput={hideOutput || refused}
      input={JSON.stringify(part.input, null, 2) ?? ""}
      output={toolOutputText(part.output)}
      outputLanguage={outputLanguageFor(part)}
      pending={part.state === "input-streaming"}
      renderOutput={renderOutput}
    >
      {children}
    </ToolPanelsBody>
  );
}

/** The end of a call that went wrong, on its own — no input or output cards. */
export function ToolPartError({ part }: { part: AgentToolPart }) {
  const error = getPartError(part);

  return error === undefined ? null : (
    <ToolErrorSection label={error.label} text={error.text} />
  );
}

type EditFilePart = Extract<
  AgentToolPart<AgentToolSet>,
  { type: "tool-edit-file" }
>;

/** Flattens one replacement block into `-` and `+` rows, so a step reads as a diff. */
const editDiffLines = (oldString: string, newString: string) => [
  ...oldString.split("\n").map((text) => ({ sign: "-" as const, text })),
  ...newString.split("\n").map((text) => ({ sign: "+" as const, text })),
];

/**
 * Parses a display diff line the tool returned, in the form `+ 12 content`. The
 * first character is the sign; the rest — line number and text — is shown as is.
 */
const parseRenderedDiffLine = (line: string) => ({
  sign: line[0] ?? " ",
  text: line.slice(1),
});

/**
 * The rows of an edit's diff: the tool's own diff once it finished, and a
 * preview built from the input before that.
 *
 * The two sources once rendered on their own, so the copy button had nothing to
 * copy. The rows are the one form that the panel and the clipboard both read.
 */
export const editDiffRows = (
  part: EditFilePart
): { sign: string; text: string }[] => {
  const actualDiff = part.output?.metadata?.diff;

  if (actualDiff) {
    return actualDiff.split("\n").map(parseRenderedDiffLine);
  }

  // While streaming, `input` is a partial, so an unfinished edit block is not
  // drawn yet.
  return (part.input?.edits ?? []).flatMap((block) =>
    typeof block?.oldText === "string" && typeof block?.newText === "string"
      ? editDiffLines(block.oldText, block.newText)
      : []
  );
};

export const editDiffText = (part: EditFilePart) =>
  editDiffRows(part)
    .map((row) => `${row.sign}${row.text}`)
    .join("\n");
