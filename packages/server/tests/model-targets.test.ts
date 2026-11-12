import { describe, expect, test } from "vitest";

import type { UserSettings } from "../src/routers/settings/settings.schema";
import { USER_SETTINGS_DEFAULTS } from "../src/routers/settings/settings.schema";
import { createModelTargetResolver } from "../src/session/model-targets";

function settings(
  overrides: Partial<NonNullable<UserSettings["providers"][number]>>
): UserSettings {
  return {
    ...USER_SETTINGS_DEFAULTS,
    providers: [
      {
        id: "test",
        name: "Test",
        protocol: "openai-chat",
        baseURL: "https://example.test/v1",
        apiKey: "key",
        active: true,
        models: [{ id: "m1", name: "M1", active: true }],
        ...overrides,
      },
    ],
  };
}

const ref = { providerId: "test", modelId: "m1" };

describe("网关目标解析", () => {
  test("解析出协议、地址和密钥", () => {
    const target = createModelTargetResolver(settings({}))(ref);

    expect(target?.protocol).toBe("openai-chat");
    expect(target?.baseURL).toBe("https://example.test/v1");
    expect(target?.apiKey).toBe("key");
  });

  test("关掉的供应商解析不到", () => {
    expect(
      createModelTargetResolver(settings({ active: false }))(ref)
    ).toBeUndefined();
  });

  test("关掉的模型解析不到：补丁路径也走这里", () => {
    const configured = settings({
      models: [{ id: "m1", name: "M1", active: false }],
    });

    expect(createModelTargetResolver(configured)(ref)).toBeUndefined();
  });

  test("没有的模型解析不到", () => {
    expect(
      createModelTargetResolver(settings({}))({
        providerId: "test",
        modelId: "nope",
      })
    ).toBeUndefined();
  });

  test("自定义请求头一起带出去", () => {
    const target = createModelTargetResolver(
      settings({ headers: { "X-Trace": "on" } })
    )(ref);

    expect(target?.headers).toStrictEqual({ "X-Trace": "on" });
  });
});
