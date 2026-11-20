/**
 * 三版工具面板的对照页。
 *
 * 只给 prototype 分支用：`vite dev` 打开 `/preview.html` 就能并排看三种排法，
 * 数据是写死的，不连 server。挑定一版后这个入口连同 `preview.html` 一起删。
 */
import "@workspace/ui/styles/globals.css";
import { Button } from "@workspace/ui/components/button";
import { Frame, FrameHeader, FrameTitle } from "@workspace/ui/components/frame";
import {
  TOOL_PANEL_VARIANTS,
  ToolPanels,
  ToolRenderedSection,
} from "@workspace/ui/elements/tool-panels";
import type { ToolPanelVariant } from "@workspace/ui/elements/tool-panels";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const VARIANT_TITLES: Record<ToolPanelVariant, string> = {
  stack: "A · Stack — one card per side",
  log: "C · Log — one card, both sides as rows",
};

const READ_INPUT = `{
  "path": "packages/ui/src/components/code-block.tsx",
  "offset": 117,
  "limit": 40
}`;

const READ_OUTPUT = `function CodeBlockContent({
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
        dir="ltr"
        className={cn(
          "min-h-0 min-w-0 px-3 py-1.5 text-start font-mono text-xs leading-[1.6]",
          "data-wrap:whitespace-pre-wrap"
        )}
      >
        <code data-slot="code-block-code" className="grid min-h-lh min-w-max">
          {children}
        </code>
      </pre>
    </ScrollArea>
  )
}`;

const BASH_INPUT = `{
  "command": "vp run -r check && vp test",
  "description": "Lint, type check and test every package",
  "timeout": 240000
}`;

const BASH_OUTPUT = `$ vp run -r check && vp test
✓ packages/shared typecheck (1.2s)
✓ packages/db typecheck (0.9s)
✓ packages/agent typecheck (2.4s)
✓ packages/server typecheck (3.1s)
✓ packages/ui typecheck (4.7s)
✓ apps/web typecheck (2.2s)
error TS2322: Type 'string | undefined' is not assignable to type 'string'. Type 'undefined' is not assignable to type 'string' — packages/ui/src/elements/tool-panels.tsx:118:9
Test Files  118 passed (118)
     Tests  942 passed (942)
  Duration  38.42s`;

const EDIT_INPUT = `{
  "path": "packages/ui/src/elements/tool-step.tsx",
  "edits": [
    {
      "oldText": "const TURN_SETTLED = new Set(["done", "error"]);",
      "newText": "const TURN_SETTLED = new Set(["done", "error", "aborted"]);"
    }
  ]
}`;

const EDIT_DIFF = `- const TURN_SETTLED = new Set(["done", "error"]);
+ const TURN_SETTLED = new Set(["done", "error", "aborted"]);`;

const APPROVAL = (
  <div className="flex items-center gap-2 border-t border-border/70 bg-muted/50 px-2.5 py-2">
    <Button size="sm">Approve</Button>
    <Button size="sm" variant="outline">
      Deny
    </Button>
  </div>
);

function DiffLines() {
  return (
    <div className="wrap-break-word font-mono text-xs whitespace-pre-wrap">
      {EDIT_DIFF.split("\n").map((line, index) => (
        <div
          className={
            line.startsWith("-") ? "text-destructive" : "text-green-600"
          }
          key={index}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

function Demo({ variant }: { variant: ToolPanelVariant }) {
  return (
    <div className="flex flex-col gap-4" data-variant={variant}>
      <h2 className="font-medium text-muted-foreground text-xs tracking-wide uppercase">
        {VARIANT_TITLES[variant]}
      </h2>

      <Frame
        className="bg-transparent shadow-none"
        overflowBehavior="scroll"
        variant="default"
      >
        <FrameHeader className="px-0">
          <FrameTitle>Read</FrameTitle>
        </FrameHeader>
        <ToolPanels
          input={READ_INPUT}
          output={READ_OUTPUT}
          outputLanguage="tsx"
          variant={variant}
        />
      </Frame>

      <Frame
        className="bg-transparent shadow-none"
        overflowBehavior="scroll"
        variant="default"
      >
        <FrameHeader className="px-0">
          <FrameTitle>Bash</FrameTitle>
        </FrameHeader>
        <ToolPanels
          approval={APPROVAL}
          errorText={undefined}
          input={BASH_INPUT}
          output={BASH_OUTPUT}
          variant={variant}
        />
      </Frame>

      <Frame
        className="bg-transparent shadow-none"
        overflowBehavior="scroll"
        variant="default"
      >
        <FrameHeader className="px-0">
          <FrameTitle>Edit</FrameTitle>
        </FrameHeader>
        <ToolPanels
          input={EDIT_INPUT}
          output="Edited 1 block in packages/ui/src/elements/tool-step.tsx"
          variant={variant}
        >
          <ToolRenderedSection copyValue={EDIT_DIFF} label="Diff">
            <DiffLines />
          </ToolRenderedSection>
        </ToolPanels>
      </Frame>
    </div>
  );
}

function Preview() {
  return (
    <div className="min-h-dvh bg-background p-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-12">
        <header className="flex items-baseline justify-between border-b pb-4">
          <h1 className="font-medium text-base">Tool panels</h1>
          <p className="text-muted-foreground text-xs">
            Same data, three arrangements
          </p>
        </header>
        {TOOL_PANEL_VARIANTS.map((variant) => (
          <Demo key={variant} variant={variant} />
        ))}
      </div>
    </div>
  );
}

const rootElement = document.querySelector("#root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
