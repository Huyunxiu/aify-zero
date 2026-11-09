import { describe, expect, test } from "vitest";

import {
  updateUserSettingsSchema,
  USER_SETTINGS_DEFAULTS,
} from "../src/routers/settings/settings.schema.js";

describe("settings patch", () => {
  test("keeps omitted fields out of the patch", () => {
    const patch = updateUserSettingsSchema.parse({ mcpServers: [] });

    // 这是回归用例：默认值曾经写进字段定义，`partial()` 会把没提交的
    // `models` 补成 `[]`，保存 MCP 服务器就把模型列表清空了。
    expect(Object.keys(patch)).toStrictEqual(["mcpServers"]);
  });

  test("keeps a submitted list intact", () => {
    const patch = updateUserSettingsSchema.parse({
      models: [
        {
          id: "openai/gpt-5",
          name: "GPT-5",
          provider: "openai",
          model: "gpt-5",
          apiUrl: "https://api.example.com",
          apiKey: "sk-test",
          compatibleType: "openai",
          active: true,
        },
      ],
    });

    expect(patch.models).toHaveLength(1);
    expect(patch.mcpServers).toBeUndefined();
  });

  test("drops an explicit undefined", () => {
    const patch = updateUserSettingsSchema.parse({ models: undefined });

    expect(patch.models).toBeUndefined();
  });
});

describe("settings defaults", () => {
  test("is a complete settings object", () => {
    expect(USER_SETTINGS_DEFAULTS.mcpServers).toStrictEqual([]);
    expect(USER_SETTINGS_DEFAULTS.compaction.auto).toBeTruthy();
  });
});
