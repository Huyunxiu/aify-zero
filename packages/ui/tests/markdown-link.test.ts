import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { FileLinkProvider, MarkdownLink } from "../src/elements/markdown-link";
import type { FileOpenTarget } from "../src/elements/markdown-link";

/** 拆开写，避免 lint 把测试里的字符串当成真的脚本地址。 */
const SCRIPT_HREF = ["java", "script:alert(1)"].join("");

/** 渲染一段链接；Provider 只在需要时包一层。 */
function render(href: string, withProvider = true): string {
  const link = createElement(MarkdownLink, { href }, "source");

  const openFile = vi.fn<(target: FileOpenTarget) => void>();

  return renderToStaticMarkup(
    withProvider ? createElement(FileLinkProvider, { openFile }, link) : link
  );
}

describe("Markdown link rendering", () => {
  test("renders a local file as a button in the session scope", () => {
    const html = render("src/a.ts:24");

    expect(html).toContain("<button");
    expect(html).toContain('data-file-link=""');
    expect(html).toContain('title="src/a.ts"');
    expect(html).toContain("source");
    expect(html).not.toContain("<a");
  });

  test("degrades to an anchor without a session scope", () => {
    const html = render("src/a.ts", false);

    expect(html).toContain('<a href="src/a.ts"');
  });

  test("opens external links in a new tab", () => {
    const html = render("https://example.com/a");

    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("keeps in-page anchors as plain links", () => {
    const html = render("#section");

    expect(html).toContain('<a href="#section"');
  });

  test("does not link an unsafe destination", () => {
    const html = render(SCRIPT_HREF);

    expect(html).not.toContain("<a");
    expect(html).not.toContain("<button");
    expect(html).toContain("source");
  });
});
