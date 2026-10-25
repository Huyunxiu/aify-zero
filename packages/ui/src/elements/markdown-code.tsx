import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@workspace/ui/components/code-block";
import { useHighlightedCode } from "@workspace/ui/hooks/use-highlighted-code";
import { cn } from "@workspace/ui/lib/utils";
import { WrapTextIcon } from "lucide-react";
import { mount } from "pele";
import * as React from "react";
import type { Components, ExtraProps } from "streamdown";
import { useIsCodeFenceIncomplete } from "streamdown";

import { Button } from "../components/button";

// 围栏代码的 children 通常是字符串；插件可能把它包成元素，这里一并处理。
function getCodeText(children: React.ReactNode) {
  if (typeof children === "string") {
    return children;
  }

  if (React.isValidElement<{ children?: React.ReactNode }>(children)) {
    return typeof children.props.children === "string"
      ? children.props.children
      : "";
  }

  return "";
}

function MermaidChart({ code }: { code: string }) {
  const incomplete = useIsCodeFenceIncomplete();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // Pele 同步绘制，并用 ResizeObserver 跟随容器宽度；放在 layout effect 里，
  // 首帧就能看到图，不会先闪一下空白边框。
  React.useLayoutEffect(() => {
    const container = containerRef.current;

    if (!container || incomplete) {
      return;
    }

    let cancelled = false;
    setErrorMessage(null);

    const diagram = mount(container, code, {
      // Pele 会把错误写进容器；这里取出来交给 React，和代码块共用错误样式。
      onError: (error) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
        }
      },
    });

    return () => {
      cancelled = true;
      diagram.destroy();
      container.replaceChildren();
    };
  }, [code, incomplete]);

  if (incomplete) {
    return (
      <div
        aria-hidden="true"
        className="my-4 h-28 animate-pulse rounded-lg border bg-muted/30"
      />
    );
  }

  return (
    <div className="my-4">
      <div
        ref={containerRef}
        className={cn(
          "pele-diagram flex justify-center rounded-lg border p-4",
          errorMessage && "hidden"
        )}
      />
      {errorMessage && (
        <div className="overflow-hidden rounded-lg border border-destructive/30 text-sm">
          <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs whitespace-pre-wrap text-destructive">
            {errorMessage}
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-xs">{code}</pre>
        </div>
      )}
    </div>
  );
}

function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  // 闭合围栏到达之前，复制按钮保持禁用。
  const incomplete = useIsCodeFenceIncomplete();
  const lines = useHighlightedCode(code, language);
  const [wrap, setWrap] = React.useState(true);

  return (
    <CodeBlock className="bg-muted">
      <CodeBlockHeader>
        <CodeBlockTitle>{language || "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Wrap lines"
            aria-pressed={wrap}
            className="aria-pressed:text-foreground"
            onClick={() => setWrap(!wrap)}
          >
            <WrapTextIcon />
          </Button>
          <CodeBlockCopyButton disabled={incomplete} value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap}>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

function MarkdownCode({
  className,
  children,
  node: _node,
  ...props
}: React.ComponentProps<"code"> & ExtraProps) {
  // Streamdown 用 data-block 标记围栏代码，其余都是行内代码。
  if (!("data-block" in props)) {
    return (
      <code
        className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]"
        {...props}
      >
        {children}
      </code>
    );
  }

  const code = getCodeText(children);
  const language = /language-(\S+)/.exec(className ?? "")?.[1] ?? "";

  return language === "mermaid" ? (
    <MermaidChart code={code} />
  ) : (
    <MarkdownCodeBlock code={code} language={language} />
  );
}

export const markdownComponents: Components = { code: MarkdownCode };
