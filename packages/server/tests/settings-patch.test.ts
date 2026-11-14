import { describe, expect, test } from "vitest";

import {
  updateUserSettingsSchema,
  USER_SETTINGS_DEFAULTS,
} from "../src/routers/settings/settings.schema.js";

describe("settings patch", () => {
  test("keeps omitted fields out of the patch", () => {
    const patch = updateUserSettingsSchema.parse({ mcpServers: [] });

    // 这是回归用例：默认值曾经写进字段定义，`partial()` 会把没提交的
    // `providers` 补成 `[]`，保存 MCP 服务器就把供应商列表清空了。
    expect(Object.keys(patch)).toStrictEqual(["mcpServers"]);
  });

  test("keeps a submitted list intact", () => {
    const patch = updateUserSettingsSchema.parse({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          protocol: "openai-responses",
          baseURL: "https://api.example.com",
          apiKey: "sk-test",
          active: true,
          models: [{ id: "gpt-5", name: "GPT-5" }],
        },
      ],
    });

    expect(patch.providers).toHaveLength(1);
    expect(patch.mcpServers).toBeUndefined();
  });

  test("drops an explicit undefined", () => {
    const patch = updateUserSettingsSchema.parse({ providers: undefined });

    expect(patch.providers).toBeUndefined();
  });
});

describe("settings defaults", () => {
  test("is a complete settings object", () => {
    expect(USER_SETTINGS_DEFAULTS.mcpServers).toStrictEqual([]);
    expect(USER_SETTINGS_DEFAULTS.compaction.auto).toBeTruthy();
  });
});
