import { PROVIDER_PRESETS } from "@workspace/shared/model";
import { describe, expect, test } from "vitest";

import { hasIcon, ICON_KEYS } from "../src/elements/brand-icon";
import {
  MAKER_PREFIXES,
  makerKeyFor,
  modelIconKey,
} from "../src/elements/model-logo";
import { providerKeyFor } from "../src/elements/provider-logo";

describe("图标键", () => {
  test("每个键都能取到资源地址", () => {
    expect(ICON_KEYS.filter((key) => !hasIcon(key))).toStrictEqual([]);
  });

  test("每个预设的图标都在键表里", () => {
    const missing = PROVIDER_PRESETS.filter((preset) => !hasIcon(preset.icon));
    expect(missing.map((preset) => preset.id)).toStrictEqual([]);
  });

  test("每个预设名字都能匹配到供应商图标", () => {
    const unmatched = PROVIDER_PRESETS.filter(
      (preset) => providerKeyFor(preset.name) === undefined
    );
    expect(unmatched.map((preset) => preset.id)).toStrictEqual([]);
  });
});

describe("模型图标", () => {
  test("每条家族前缀都指向存在的键", () => {
    const missing = MAKER_PREFIXES.filter(([, key]) => !hasIcon(key));
    expect(missing).toStrictEqual([]);
  });

  test("按模型 id 的家族前缀找出品方", () => {
    expect(makerKeyFor("claude-sonnet-4")).toBe("claude-color");
    expect(makerKeyFor("gpt-4o")).toBe("openai");
    expect(makerKeyFor("gemini-2.0-flash")).toBe("gemini-color");
    expect(makerKeyFor("deepseek-v3")).toBe("deepseek-color");
    expect(makerKeyFor("glm-5")).toBe("zhipu-color");
  });

  test("中转站的 vendor/ 前缀不参与匹配", () => {
    expect(makerKeyFor("anthropic/claude-sonnet-4")).toBe("claude-color");
    expect(makerKeyFor("openai/gpt-4o")).toBe("openai");
  });

  test("认不出出品方时退回所属供应商", () => {
    expect(
      modelIconKey({ model: "my-finetune-v1", providerIcon: "openrouter" })
    ).toBe("openrouter");
  });

  test("都认不出时用中性图标", () => {
    expect(modelIconKey({ model: "my-finetune-v1" })).toBe("generic");
    expect(
      modelIconKey({ model: "my-finetune-v1", providerIcon: "no-such-icon" })
    ).toBe("generic");
  });

  test("显式键优先于出品方", () => {
    expect(modelIconKey({ model: "claude-sonnet-4", icon: "openrouter" })).toBe(
      "openrouter"
    );
  });
});
