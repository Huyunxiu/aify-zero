import { WrapTextIcon } from "lucide-react";
import * as React from "react";

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
import { cn } from "../lib/utils";

/**
 * A tool call reads twice: what it was asked, and what it answered. Both are
 * code — JSON and raw text — so both are drawn as code blocks instead of as
 * `whitespace-pre` text, which neither wraps nor keeps the monospaced column.
 *
 * Three arrangements are kept while one is chosen:
 *
 * - `stack`: one card per side. Closest to the panel it replaces.
 * - `tabs`: one card, one side visible. Halves the height of a long call.
 * - `log`: one card, both sides in a row each. Densest, reads like a transcript.
 */
export const TOOL_PANEL_VARIANTS = ["stack", "tabs", "log"] as const;
export type ToolPanelVariant = (typeof TOOL_PANEL_VARIANTS)[number];

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
    <CodeBlock className={cn("shrink-0", className)}>
      <CodeBlockHeader className="group/section h-8 gap-2 pr-1.5">
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
    <CodeBlock className="shrink-0">
      <CodeBlockHeader className="group/section h-8 pr-1.5">
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

/** The error a failed call carries, drawn in the code block's red variant. */
export const ToolErrorSection = ({ text }: { text: string }) => (
  <CodeBlock variant="destructive">
    <CodeBlockHeader className="group/section h-8 border-destructive/20 bg-destructive/5 pr-1.5">
      <CodeBlockTitle className="text-destructive">Error</CodeBlockTitle>
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
};

/**
 * `stack` — one card per side.
 *
 * The titles move into the cards, so the two ends of a call read as two blocks
 * of the same kind instead of as a floating label over a white panel.
 */
const StackPanels = ({
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
}: PanelsProps) => (
  <div className="flex flex-col gap-1.5 p-1.5">
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
    {errorText === undefined ? null : <ToolErrorSection text={errorText} />}
  </div>
);

/**
 * `tabs` — one card, one side visible.
 *
 * The side that matters flips to the answer as soon as the call answers, and
 * the tabs take over the moment the reader picks a side themselves.
 */
const TabsPanels = ({
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
}: PanelsProps) => {
  const [chosen, setChosen] = React.useState<"input" | "output" | null>(null);
  const [wrapOverrides, setWrapOverrides] = React.useState<
    Partial<Record<"input" | "output", boolean>>
  >({});
  const id = React.useId();

  const hasOutput = !hideOutput && output.length > 0;
  // Until the reader picks, the answer wins: it is what a finished call is for,
  // and it is only there once the call is over.
  const active = chosen ?? (hasOutput ? "output" : "input");
  const value = active === "input" ? input : output;
  const language = active === "input" ? inputLanguage : outputLanguage;
  const wrap = wrapOverrides[active] ?? language === "text";

  return (
    <div className="flex flex-col gap-1.5 p-1.5">
      <CodeBlock className="shrink-0">
        <CodeBlockHeader className="group/section h-8 gap-2 pr-1.5">
          <div
            aria-label="Tool call content"
            className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                return;
              }

              event.preventDefault();
              setChosen(active === "input" ? "output" : "input");
            }}
            role="tablist"
            // The tabs inside take the tab stops; the list is only a landmark.
            tabIndex={-1}
          >
            {(["input", "output"] as const).map((side) => (
              <button
                key={side}
                aria-controls={`${id}-panel`}
                aria-selected={active === side}
                id={`${id}-${side}`}
                role="tab"
                tabIndex={active === side ? 0 : -1}
                className={cn(
                  "h-6 rounded-[5px] px-2 font-medium text-[11px] transition-colors duration-150 ease-out outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ring/50",
                  active === side
                    ? "bg-background text-foreground shadow-2xs dark:bg-input"
                    : "text-muted-foreground hover:text-foreground",
                  side === "output" && !hasOutput && "opacity-45"
                )}
                onClick={() => setChosen(side)}
                type="button"
              >
                {side === "input" ? "Input" : "Output"}
              </button>
            ))}
          </div>
          <CodeBlockActions className="gap-2">
            <span className={LANGUAGE_CLASS}>{language}</span>
            <ToolWrapToggle
              className={HOVER_CONTROL_CLASS}
              onToggle={() =>
                setWrapOverrides((previous) => ({
                  ...previous,
                  [active]: !wrap,
                }))
              }
              pressed={wrap}
            />
            <CodeBlockCopyButton
              className="text-muted-foreground/60 hover:text-foreground"
              disabled={value.length === 0}
              value={value}
            />
          </CodeBlockActions>
        </CodeBlockHeader>
        {active === "output" && renderOutput !== undefined ? (
          <div
            aria-labelledby={`${id}-output`}
            className="animate-in fade-in-0 p-3 text-sm duration-150 motion-reduce:animate-none"
            id={`${id}-panel`}
            role="tabpanel"
          >
            {renderOutput(output)}
          </div>
        ) : (
          // The body is keyed by side so the fade runs on every switch; the
          // height snaps, because a growing card during a read is worse than a
          // jump between two known heights.
          <div
            aria-labelledby={`${id}-${active}`}
            className="animate-in fade-in-0 duration-150 motion-reduce:animate-none"
            id={`${id}-panel`}
            key={active}
            role="tabpanel"
          >
            <ToolCodeBody
              language={language}
              pending={pending}
              value={value}
              wrap={wrap}
            />
          </div>
        )}
        {approval}
      </CodeBlock>
      {children}
      {errorText === undefined ? null : <ToolErrorSection text={errorText} />}
    </div>
  );
};

/**
 * `log` — one card, both sides as rows.
 *
 * Nothing repeats: one border, one surface, the titles in the smallest type the
 * scale has. It is the version for readers who open a call and scan it.
 */
const LogPanels = ({
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
}: PanelsProps) => (
  <div className="flex flex-col gap-1.5 p-1.5">
    <CodeBlock className="shrink-0">
      <ToolLogRow
        footer={approval}
        label="Input"
        language={inputLanguage}
        pending={pending}
        value={input}
      />
      {hideOutput ? null : renderOutput === undefined ? (
        <ToolLogRow
          className="border-t border-border/70"
          label="Output"
          language={outputLanguage}
          value={output}
        />
      ) : (
        <div className="border-t border-border/70">
          <div className="flex h-7 items-center gap-2 px-3">
            <span className="font-mono font-medium text-[10px] text-muted-foreground uppercase leading-none tracking-[0.14em]">
              Output
            </span>
            <span className={LANGUAGE_CLASS}>{outputLanguage}</span>
          </div>
          <div className="overflow-x-auto p-3 text-sm">
            {renderOutput(output)}
          </div>
        </div>
      )}
    </CodeBlock>
    {children}
    {errorText === undefined ? null : <ToolErrorSection text={errorText} />}
  </div>
);

function ToolLogRow({
  label,
  language,
  value,
  pending,
  footer,
  className,
}: {
  label: string;
  language?: string;
  value: string;
  pending?: boolean;
  footer?: React.ReactNode;
  className?: string;
}) {
  const [wrap, setWrap] = React.useState(
    language === undefined || language === "text"
  );

  return (
    <div className={cn("group/section", className)}>
      <div className="flex h-7 items-center gap-2 px-3">
        <span className="font-mono font-medium text-[10px] text-muted-foreground uppercase leading-none tracking-[0.14em]">
          {label}
        </span>
        {language === undefined ? null : (
          <span className={LANGUAGE_CLASS}>{language}</span>
        )}
        <CodeBlockActions className="gap-1">
          <ToolWrapToggle
            className={cn(HOVER_CONTROL_CLASS, "text-muted-foreground/50")}
            onToggle={() => setWrap((previous) => !previous)}
            pressed={wrap}
          />
          <CodeBlockCopyButton
            className="text-muted-foreground/50 hover:text-foreground"
            disabled={value.length === 0}
            value={value}
          />
        </CodeBlockActions>
      </div>
      <ToolCodeBody
        className="px-3 pb-1.5"
        language={language ?? "text"}
        pending={pending}
        value={value}
        viewportClassName="max-h-[min(14rem,32vh)]"
        wrap={wrap}
      />
      {footer}
    </div>
  );
}

export function ToolPanels({
  variant = "stack",
  ...props
}: PanelsProps & { variant?: ToolPanelVariant }) {
  if (variant === "tabs") {
    return <TabsPanels {...props} />;
  }

  if (variant === "log") {
    return <LogPanels {...props} />;
  }

  return <StackPanels {...props} />;
}
