import * as React from "react";

import { loadHighlighter } from "../lib/highlighter";

type Highlighter = Awaited<ReturnType<typeof loadHighlighter>>;

type Highlighted = {
  highlighter: Highlighter;
  text: string;
  lines: React.ReactNode[];
  state?: Parameters<NonNullable<Highlighter>["highlight"]>[1];
};

export function useHighlightedCode(value: string, language: string) {
  // 结尾的换行会多渲染一行空行。
  const code = value.endsWith("\n") ? value.slice(0, -1) : value;

  const [loaded, setLoaded] = React.useState<{
    language: string;
    highlighter: Highlighter;
  } | null>(null);
  const highlighter = loaded?.language === language ? loaded.highlighter : null;

  React.useEffect(() => {
    let cancelled = false;

    loadHighlighter(language)
      .then((next) => {
        if (!cancelled) {
          setLoaded({ highlighter: next, language });
        }
      })
      .catch(() => null);

    return () => {
      cancelled = true;
    };
  }, [language]);

  // 已经完整到达的行做增量高亮，流式输出时只处理新增的行。
  const [done, setDone] = React.useState<Highlighted>({
    highlighter: null,
    lines: [],
    text: "",
  });

  let next = done;

  if (next.highlighter !== highlighter || !code.startsWith(next.text)) {
    next = { highlighter, lines: [], text: "" };
  }

  const end = code.lastIndexOf("\n") + 1;

  if (highlighter && end > next.text.length) {
    const result = highlighter.highlight(
      code.slice(next.text.length, end - 1),
      next.state
    );

    next = {
      highlighter,
      lines: [...next.lines, ...result.lines],
      state: result.state,
      text: code.slice(0, end),
    };
  }

  if (next !== done) {
    setDone(next);
  }

  // 最后一行仍在写入，每次渲染都重新做高亮。
  const tail = code.slice(end);

  return React.useMemo(() => {
    if (!highlighter) {
      return code.split("\n");
    }

    return [...next.lines, highlighter.highlight(tail, next.state).lines[0]];
  }, [code, highlighter, next, tail]);
}
