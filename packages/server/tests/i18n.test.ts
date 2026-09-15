import { describe, expect, test } from "vitest";

import { ErrorMap } from "../src/errors";
import { errorMessage, t } from "../src/i18n";
import enUSMessages from "../src/i18n/locales/en-US/common.json";
import enUSErrors from "../src/i18n/locales/en-US/errors.json";
import zhCNMessages from "../src/i18n/locales/zh-CN/common.json";
import zhCNErrors from "../src/i18n/locales/zh-CN/errors.json";

const keysOf = (catalog: object) => Object.keys(catalog).sort();

describe("i18n.t", () => {
  test("should read each message in the language it is asked for", () => {
    expect(t("en-US", "lang.displayName")).toBe("English");
    expect(t("zh-CN", "lang.displayName")).toBe("中文");
  });

  // The type only catches a key a language is missing; a key it carries on top
  // of the reference is invisible to it, so the catalogs are compared here.
  test("should carry the same keys in every language", () => {
    expect(keysOf(zhCNMessages)).toStrictEqual(keysOf(enUSMessages));
  });
});

describe("i18n.errorMessage", () => {
  test("should read each code in the language it is asked for", () => {
    expect(errorMessage("en-US", "NOTHING_TO_FORK")).toBe(
      "There is nothing to fork in this chat yet."
    );
    expect(errorMessage("zh-CN", "NOTHING_TO_FORK")).toBe(
      "该会话暂无可分叉的内容。"
    );
  });

  // `Record<ErrorCode, string>` already fails the build when a language is
  // missing a code; this is the other direction, plus the reminder that a code
  // dropped from `ErrorMap` has to be dropped from here too.
  test("should cover exactly the codes the error map declares", () => {
    const codes = keysOf(ErrorMap);

    expect(keysOf(enUSErrors)).toStrictEqual(codes);
    expect(keysOf(zhCNErrors)).toStrictEqual(codes);
  });
});
