/**
 * A provider key: the stored one, or a reference to a named environment variable.
 *
 * The assertions stay on external behaviour: which key is resolved, which sentence a
 * failure carries, and what shape a variable name may take.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  PROVIDER_KEY_ENV_PREFIX,
  providerKey,
  providerKeyEnvSchema,
} from "../src/routers/settings/provider-key";
import type { Provider } from "../src/routers/settings/settings.schema";
import { providerSchema } from "../src/routers/settings/settings.schema";

const ENV = `${PROVIDER_KEY_ENV_PREFIX}TEST`;

function row(overrides: Record<string, unknown>) {
  return {
    id: "p",
    name: "P",
    protocol: "openai-chat",
    baseURL: "https://example.test/v1",
    apiKey: "stored-key",
    active: true,
    models: [],
    ...overrides,
  };
}

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test",
    name: "Test",
    protocol: "openai-chat",
    baseURL: "https://example.test/v1",
    apiKey: "stored-key",
    active: true,
    models: [],
    ...overrides,
  };
}

describe("供应商密钥", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("没指名变量时用存下来的那一把", () => {
    expect(providerKey(provider())).toBe("stored-key");
  });

  test("指名变量时从环境里读，存下来的那一把不起作用", () => {
    vi.stubEnv(ENV, "env-key");

    expect(providerKey(provider({ apiKey: "", apiKeyEnv: ENV }))).toBe(
      "env-key"
    );
  });

  test("环境里的值两边的空白去掉", () => {
    vi.stubEnv(ENV, "  env-key\n");

    expect(providerKey(provider({ apiKey: "", apiKeyEnv: ENV }))).toBe(
      "env-key"
    );
  });

  test("变量没设时点名这个变量", () => {
    expect(() => providerKey(provider({ apiKey: "", apiKeyEnv: ENV }))).toThrow(
      ENV
    );
  });

  test("变量只有空白也算没设，同样点名它", () => {
    vi.stubEnv(ENV, "   ");

    expect(() => providerKey(provider({ apiKey: "", apiKeyEnv: ENV }))).toThrow(
      ENV
    );
  });

  test("没指名变量时，空着的旧密钥原样返回，不报错", () => {
    expect(providerKey(provider({ apiKey: "" }))).toBe("");
  });
});

describe("变量名规则", () => {
  test(`只接受 ${PROVIDER_KEY_ENV_PREFIX} 命名空间里的名字`, () => {
    expect(providerKeyEnvSchema.safeParse(`${ENV}_2`).success).toBeTruthy();
    expect(
      providerKeyEnvSchema.safeParse("OPENAI_API_KEY").success
    ).toBeFalsy();
    expect(
      providerKeyEnvSchema.safeParse("AWS_ACCESS_KEY_ID").success
    ).toBeFalsy();
    // The prefix alone is not a name: at least one character follows it.
    expect(
      providerKeyEnvSchema.safeParse(PROVIDER_KEY_ENV_PREFIX).success
    ).toBeFalsy();
  });
});

describe("供应商行的密钥来源", () => {
  test("指名一个变量时，行上不能同时留着一把密钥", () => {
    expect(
      providerSchema.safeParse(row({ apiKey: "", apiKeyEnv: ENV })).success
    ).toBeTruthy();
    expect(
      providerSchema.safeParse(row({ apiKey: "stored-key", apiKeyEnv: ENV }))
        .success
    ).toBeFalsy();
  });

  test("命名空间外的变量名在保存那一刻就被拒", () => {
    expect(
      providerSchema.safeParse(row({ apiKey: "", apiKeyEnv: "PATH" })).success
    ).toBeFalsy();
  });

  test("两种来源都不写仍然可以存：空密钥的旧行不是错误", () => {
    expect(providerSchema.safeParse(row({ apiKey: "" })).success).toBeTruthy();
  });
});
