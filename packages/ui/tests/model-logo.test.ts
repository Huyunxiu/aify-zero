import { PROVIDER_PRESETS } from "@workspace/shared/model";
import { describe, expect, test } from "vitest";

import { hasLogo, logoKeyFor } from "../src/elements/model-logo";

describe("品牌图标", () => {
  test("每个内置预设都有图标", () => {
    const missing = PROVIDER_PRESETS.filter((preset) => !hasLogo(preset.icon));
    expect(missing.map((preset) => preset.id)).toStrictEqual([]);
  });

  test("每个预设名字都能匹配到图标", () => {
    const unmatched = PROVIDER_PRESETS.filter(
      (preset) => logoKeyFor(preset.name) === undefined
    );
    expect(unmatched.map((preset) => preset.id)).toStrictEqual([]);
  });
});
