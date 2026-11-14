import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { BrandIcon } from "../src/elements/brand-icon";

describe("品牌图渲染", () => {
  test("彩色键画 <img>，源是资源地址", () => {
    const html = renderToStaticMarkup(<BrandIcon name="claude-color" />);
    expect(html).toContain("<img");
    expect(html).toContain('src="');
  });

  test("单色键画 mask，颜色跟随文字", () => {
    const html = renderToStaticMarkup(<BrandIcon name="openai" />);
    expect(html).not.toContain("<img");
    expect(html).toContain("mask-image");
  });

  test("认不出的键画中性图标", () => {
    const html = renderToStaticMarkup(<BrandIcon name="no-such-icon" />);
    expect(html).toContain("<svg");
  });
});
