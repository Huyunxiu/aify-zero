import { LANGUAGE_HEADER } from "@workspace/shared/constants";
import { describe, expect, test } from "vitest";

import { app } from "../src/app";

/**
 * The whole ride in one place: the header the client sends, the language the
 * context ends up with, and the message that comes back. oRPC's RPC transport
 * answers `POST /rpc/<path>` with the result wrapped in `{ json }`, hence the
 * unwrapping below.
 */
const ask = (language?: string) =>
  app.request("/rpc/lang", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(language === undefined ? {} : { [LANGUAGE_HEADER]: language }),
    },
    body: "{}",
  });

describe("lang", () => {
  test("should name the language it was asked in, in that language", async () => {
    const chinese = await ask("zh-CN");

    expect(chinese.status).toBe(200);
    await expect(chinese.json()).resolves.toStrictEqual({
      json: { message: "中文" },
    });

    const english = await ask("en-US");

    await expect(english.json()).resolves.toStrictEqual({
      json: { message: "English" },
    });
  });

  test("should answer in the default language when asked for none", async () => {
    const res = await ask();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({
      json: { message: "English" },
    });
  });
});
