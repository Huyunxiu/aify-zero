import { DEFAULT_LANGUAGE, LANGUAGE_HEADER } from "@workspace/shared/constants";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { app } from "../src/app";
import type { Context, CreateContextOptions } from "../src/context";
import { createContext } from "../src/context";

// The language never reaches the response — it is there for the handlers to
// read — so it can only be asserted where the app hands it over: the argument
// of the `createContext` call the oRPC middleware below makes.
vi.mock(import("../src/context"), () => ({
  createContext: vi.fn<(options: CreateContextOptions) => Promise<Context>>(),
}));

const createContextMock = vi.mocked(createContext);

const askedFor = () => createContextMock.mock.calls.at(-1)?.[0].language;

describe("request language", () => {
  beforeEach(() => {
    createContextMock.mockClear();
  });

  test("should take the language the header asks for", async () => {
    await app.request("/", { headers: { [LANGUAGE_HEADER]: "zh-CN" } });

    expect(askedFor()).toBe("zh-CN");
  });

  test("should match the header without regard to case", async () => {
    await app.request("/", { headers: { [LANGUAGE_HEADER]: "ZH-cn" } });

    expect(askedFor()).toBe("zh-CN");
  });

  test("should fall back to the default for a language it ships no translations for", async () => {
    await app.request("/", { headers: { [LANGUAGE_HEADER]: "de-DE" } });

    expect(askedFor()).toBe(DEFAULT_LANGUAGE);
  });

  test("should ignore the language the browser would prefer", async () => {
    await app.request("/", {
      headers: { "accept-language": "zh-CN,en;q=0.9" },
    });

    expect(askedFor()).toBe(DEFAULT_LANGUAGE);
  });

  test("should fall back to the default for a request that asks for nothing", async () => {
    await app.request("/");

    expect(askedFor()).toBe(DEFAULT_LANGUAGE);
  });
});
