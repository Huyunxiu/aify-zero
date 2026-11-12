import { describe, expect, test } from "vitest";

import {
  normalizeBaseURL,
  normalizeUserSettings,
} from "../src/routers/settings/settings.normalize";
import { USER_SETTINGS_DEFAULTS } from "../src/routers/settings/settings.schema";

/** 旧设置里的一条模型：接入信息在每条上重复。 */
function legacyModel(overrides: Record<string, unknown>) {
  return {
    id: "DeepSeek/deepseek-v4-flash",
    name: "deepseek-v4-flash",
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
    apiUrl: "https://api.deepseek.com",
    apiKey: "sk-test",
    compatibleType: "openai",
    active: true,
    reasoning: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 65_536 },
    ...overrides,
  };
}

describe("基地址规范化", () => {
  test("去掉协议追加的那段路径", () => {
    expect(
      normalizeBaseURL(
        "https://api.deepseek.com/v1/chat/completions",
        "openai-chat"
      )
    ).toBe("https://api.deepseek.com/v1");
    expect(
      normalizeBaseURL(
        "https://api.openai.com/v1/responses",
        "openai-responses"
      )
    ).toBe("https://api.openai.com/v1");
  });

  test("补上协议、去掉尾部斜杠", () => {
    expect(normalizeBaseURL("api.example.com/v1/", "openai-chat")).toBe(
      "https://api.example.com/v1"
    );
  });

  test("路径里的 /responses 保留，只去掉结尾的那一段", () => {
    expect(
      normalizeBaseURL("https://x.dev/responses-proxy", "openai-responses")
    ).toBe("https://x.dev/responses-proxy");
  });
});

describe("旧设置归一化", () => {
  test("同一供应商的多条模型归并成一条供应商", () => {
    const settings = normalizeUserSettings(
      {
        models: [
          legacyModel({}),
          legacyModel({
            id: "DeepSeek/deepseek-v4-pro",
            name: "deepseek-v4-pro",
            model: "deepseek-v4-pro",
          }),
        ],
      },
      USER_SETTINGS_DEFAULTS
    );

    expect(settings.providers).toHaveLength(1);
    expect(settings.providers[0]?.id).toBe("deepseek");
    expect(
      settings.providers[0]?.models.map((model) => model.id)
    ).toStrictEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  test("地址或密钥不同的记录是两条供应商", () => {
    const settings = normalizeUserSettings(
      {
        models: [
          legacyModel({}),
          legacyModel({ id: "Other/x", provider: "Other", model: "x" }),
        ],
      },
      USER_SETTINGS_DEFAULTS
    );

    expect(settings.providers).toHaveLength(2);
    expect(settings.providers.map((provider) => provider.id)).toStrictEqual([
      "deepseek",
      "other",
    ]);
  });

  test("模型 id 取 model 字段，不信旧 id 的前缀", () => {
    const settings = normalizeUserSettings(
      {
        models: [
          legacyModel({
            id: "Maas/ling-3.0-flash-sante",
            provider: "AntGroup",
            model: "ling-3.0-flash-sante",
          }),
        ],
      },
      USER_SETTINGS_DEFAULTS
    );

    expect(settings.providers[0]?.id).toBe("antgroup");
    expect(settings.providers[0]?.models[0]?.id).toBe("ling-3.0-flash-sante");
  });

  test("旧的字符串默认模型按第一个斜杠拆开并校验", () => {
    const settings = normalizeUserSettings(
      {
        models: [legacyModel({})],
        defaultModel: "deepseek/deepseek-v4-flash",
      },
      USER_SETTINGS_DEFAULTS
    );

    expect(settings.defaultModel).toStrictEqual({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    });
  });

  test("指向不存在的模型时默认模型置空", () => {
    const settings = normalizeUserSettings(
      { models: [legacyModel({})], defaultModel: "nope/nope" },
      USER_SETTINGS_DEFAULTS
    );

    expect(settings.defaultModel).toBeNull();
  });

  test("已经是新形状时原样通过，并且幂等", () => {
    const once = normalizeUserSettings(
      {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            protocol: "openai-responses",
            baseURL: "https://api.openai.com/v1/",
            apiKey: "sk-test",
            active: true,
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                active: true,
                reasoning: true,
                modalities: { input: ["text"], output: ["text"] },
                limit: { context: 400_000 },
              },
            ],
          },
        ],
        defaultModel: { providerId: "openai", modelId: "gpt-5.5" },
      },
      USER_SETTINGS_DEFAULTS
    );
    const twice = normalizeUserSettings(once, USER_SETTINGS_DEFAULTS);

    expect(twice).toStrictEqual(once);
    expect(once.providers[0]?.baseURL).toBe("https://api.openai.com/v1");
  });

  test("同名的两条供应商不会撞 id", () => {
    const settings = normalizeUserSettings(
      {
        providers: [
          {
            id: "custom",
            name: "Custom",
            protocol: "openai-chat",
            baseURL: "https://a.dev/v1",
            apiKey: "",
            active: true,
            models: [],
          },
          {
            id: "custom",
            name: "Custom",
            protocol: "openai-chat",
            baseURL: "https://b.dev/v1",
            apiKey: "",
            active: true,
            models: [],
          },
        ],
      },
      USER_SETTINGS_DEFAULTS
    );

    expect(settings.providers.map((provider) => provider.id)).toStrictEqual([
      "custom",
      "custom-2",
    ]);
  });
});
