import { describe, expect, test } from "vitest";

import {
  hasOneKeySource,
  isProviderKeyEnvName,
  PROVIDER_KEY_ENV_PREFIX,
  providerKeyReference,
} from "../src/provider-key";

describe("provider key reference", () => {
  test("accepts a name inside the namespace", () => {
    expect(
      isProviderKeyEnvName(`${PROVIDER_KEY_ENV_PREFIX}OPENAI`)
    ).toBeTruthy();
    expect(
      isProviderKeyEnvName(`${PROVIDER_KEY_ENV_PREFIX}openai_2`)
    ).toBeTruthy();
  });

  test("rejects a name outside the namespace, including the bare prefix", () => {
    expect(isProviderKeyEnvName("OPENAI_API_KEY")).toBeFalsy();
    expect(isProviderKeyEnvName("AWS_ACCESS_KEY_ID")).toBeFalsy();
    expect(isProviderKeyEnvName(PROVIDER_KEY_ENV_PREFIX)).toBeFalsy();
    expect(isProviderKeyEnvName(`${PROVIDER_KEY_ENV_PREFIX}A-B`)).toBeFalsy();
  });
});

describe("one source per row", () => {
  test("a stored key alone is one source", () => {
    expect(hasOneKeySource({ apiKey: "sk-test" })).toBeTruthy();
  });

  test("a reference alone is one source, with or without an empty key", () => {
    expect(
      hasOneKeySource({ apiKey: "", apiKeyEnv: `${PROVIDER_KEY_ENV_PREFIX}A` })
    ).toBeTruthy();
    expect(
      hasOneKeySource({
        apiKey: "   ",
        apiKeyEnv: `${PROVIDER_KEY_ENV_PREFIX}A`,
      })
    ).toBeTruthy();
  });

  test("a key and a reference together are two sources", () => {
    expect(
      hasOneKeySource({
        apiKey: "sk-test",
        apiKeyEnv: `${PROVIDER_KEY_ENV_PREFIX}A`,
      })
    ).toBeFalsy();
  });
});

describe("the reference to save", () => {
  test("keeps the reference when no key is typed", () => {
    expect(
      providerKeyReference({
        apiKey: "",
        apiKeyEnv: `${PROVIDER_KEY_ENV_PREFIX}A`,
      })
    ).toBe(`${PROVIDER_KEY_ENV_PREFIX}A`);
  });

  test("drops the reference once a key is typed", () => {
    expect(
      providerKeyReference({
        apiKey: "sk-typed",
        apiKeyEnv: `${PROVIDER_KEY_ENV_PREFIX}A`,
      })
    ).toBeUndefined();
  });

  test("has nothing to save when the row names no variable", () => {
    expect(providerKeyReference({ apiKey: "" })).toBeUndefined();
  });
});
