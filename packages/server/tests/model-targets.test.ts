import { afterEach, describe, expect, test, vi } from "vitest";

import { PROVIDER_KEY_ENV_PREFIX } from "../src/routers/settings/provider-key";
import type { UserSettings } from "../src/routers/settings/settings.schema";
import { USER_SETTINGS_DEFAULTS } from "../src/routers/settings/settings.schema";
import { createModelTargetResolver } from "../src/session/model-targets";

const ENV = `${PROVIDER_KEY_ENV_PREFIX}TEST`;

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  test("指名环境变量时，密钥来自环境", () => {
    vi.stubEnv(ENV, "env-key");

    const target = createModelTargetResolver(
      settings({ apiKey: "", apiKeyEnv: ENV })
    )(ref);

    expect(target?.apiKey).toBe("env-key");
  });

  test("变量为空时报的是这个变量，不是「模型没配置」", () => {
    expect(() =>
      createModelTargetResolver(settings({ apiKey: "", apiKeyEnv: ENV }))(ref)
    ).toThrow(ENV);
  });

  test("每次解析都读环境，不缓存", () => {
    vi.stubEnv(ENV, "first");
    const resolve = createModelTargetResolver(
      settings({ apiKey: "", apiKeyEnv: ENV })
    );

    expect(resolve(ref)?.apiKey).toBe("first");
    vi.stubEnv(ENV, "second");
    expect(resolve(ref)?.apiKey).toBe("second");
  });

  test("一家缺变量只挡住它自己", () => {
    const twoProviders: UserSettings = {
      ...USER_SETTINGS_DEFAULTS,
      providers: [
        {
          id: "ready",
          name: "Ready",
          protocol: "openai-chat",
          baseURL: "https://ready.test/v1",
          apiKey: "ready-key",
          active: true,
          models: [{ id: "m1", name: "M1", active: true }],
        },
        {
          id: "broken",
          name: "Broken",
          protocol: "openai-chat",
          baseURL: "https://broken.test/v1",
          apiKey: "",
          apiKeyEnv: `${PROVIDER_KEY_ENV_PREFIX}BROKEN`,
          active: true,
          models: [{ id: "m1", name: "M1", active: true }],
        },
      ],
    };
    const resolve = createModelTargetResolver(twoProviders);

    expect(resolve({ providerId: "ready", modelId: "m1" })?.apiKey).toBe(
      "ready-key"
    );
    expect(() => resolve({ providerId: "broken", modelId: "m1" })).toThrow(
      `${PROVIDER_KEY_ENV_PREFIX}BROKEN`
    );
  });
});
