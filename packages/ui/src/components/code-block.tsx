"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { CheckIcon, CopyIcon } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard"
import { Button } from "./button"
import { ScrollArea } from "./scroll-area"

const codeBlockVariants = cva(
  "group/code-block relative flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-neutral-12 text-sm has-[[data-slot=scroll-area-viewport]:focus-visible]:border-ring",
  {
    variants: {
      variant: {
        default: "text-foreground",
        destructive:
          "border-destructive/30 text-destructive dark:border-destructive/40",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function CodeBlock({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof codeBlockVariants>) {
  return (
    <div
      data-slot="code-block"
      data-variant={variant}
      className={cn(codeBlockVariants({ variant }), className)}
      {...props}
    />
  )
}

function CodeBlockHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-header"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2.5 border-b border-border bg-muted/50 px-3",
        className
      )}
      {...props}
    />
  )
}

function CodeBlockTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-title"
      className={cn(
        "min-w-0 truncate font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase group-data-[variant=destructive]/code-block:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function CodeBlockActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-actions"
      className={cn("ms-auto flex shrink-0 items-center gap-0.5", className)}
      {...props}
    />
  )
}

function CodeBlockCopyButton({
  value,
  variant = "ghost",
  size = "icon-xs",
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button> & { value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard()

  return (
    <>
      <Button
        data-slot="code-block-copy-button"
        data-copied={isCopied || undefined}
        variant={variant}
        size={size}
        aria-label={isCopied ? "Copied" : "Copy"}
        className={cn("text-muted-foreground", className)}
        onClick={(event) => {
          onClick?.(event)
          copyToClipboard(value)
        }}
        {...props}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <span aria-live="polite" className="sr-only">
        {isCopied ? "Copied" : ""}
      </span>
    </>
  )
}

function CodeBlockContent({
  className,
  children,
  style,
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  viewportClassName,
  ...props
}: React.ComponentProps<"pre"> & {
  wrap?: boolean
  lineNumbers?: boolean
  startLine?: number
  viewportClassName?: string
}) {
  return (
    <ScrollArea
      className="min-h-0 min-w-0"
      orientation="both"
      viewportClassName={cn("scroll-fade-both", viewportClassName)}
    >
      <pre
        data-slot="code-block-content"
        data-wrap={wrap || undefined}
        data-numbered={lineNumbers || undefined}
        dir="ltr"
        style={{ counterReset: `line ${startLine - 1}`, ...style }}
        className={cn(
          "min-h-0 min-w-0 px-3 py-1.5 text-start font-mono text-xs leading-[1.6] outline-none data-wrap:wrap-break-word data-wrap:whitespace-pre-wrap",
          className
        )}
        {...props}
      >
        <code
          data-slot="code-block-code"
          className="grid min-h-lh min-w-max content-start in-data-numbered:grid-cols-[auto_1fr] in-data-wrap:min-w-0"
        >
          {lineNumbers && typeof children === "string"
            ? children
                .replace(/\n$/, "")
                .split("\n")
                .map((line, index) => (
                  <CodeBlockLine key={index}>{line}</CodeBlockLine>
                ))
            : children}
        </code>
      </pre>
    </ScrollArea>
  )
}

const codeBlockLineVariants = cva(
  "relative -mx-3 block min-h-lh px-3 before:min-w-7 before:text-end before:text-muted-foreground/60 after:absolute after:start-1 after:top-0 after:text-muted-foreground after:select-none in-data-numbered:col-span-2 in-data-numbered:grid in-data-numbered:grid-cols-subgrid in-data-numbered:gap-x-3 in-data-numbered:[counter-increment:line] in-data-numbered:before:content-[counter(line)] in-data-numbered:before:select-none in-data-numbered:supports-[content:counter(line)_/_'']:before:content-[counter(line)_/_'']",
  {
    variants: {
      variant: {
        default: "",
        added: "bg-muted after:content-['+']",
        removed: "bg-destructive/10 after:text-destructive after:content-['−']",
        highlighted: "bg-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function CodeBlockLine({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof codeBlockLineVariants>) {
  // 空行也保留换行，复制整段代码时不会丢行。
  const empty =
    children === undefined ||
    children === null ||
    children === "" ||
    (Array.isArray(children) && children.length === 0)

  return (
    <span
      data-slot="code-block-line"
      data-variant={variant}
      className={cn(codeBlockLineVariants({ variant }), className)}
      {...props}
    >
      <span data-slot="code-block-line-content" className="min-w-0">
        {empty ? "\n" : children}
      </span>
    </span>
  )
}

export {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
  CodeBlockLine,
}
