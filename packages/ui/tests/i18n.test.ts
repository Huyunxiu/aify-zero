import { describe, expect, test } from "vitest";

import enUS from "../src/i18n/locales/en-US/common.json";
import zhCN from "../src/i18n/locales/zh-CN/common.json";

/** 把嵌套文案压成「路径 → 文本」，只保留叶子。 */
function flatten(node: object, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();

  for (const [key, value] of Object.entries(node)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;

    if (typeof value === "string") {
      out.set(path, value);
    } else {
      for (const [child, text] of flatten(value, path)) {
        out.set(child, text);
      }
    }
  }

  return out;
}

describe("UI 文案", () => {
  test("两种语言的键完全一致", () => {
    const english = [...flatten(enUS).keys()].toSorted();
    const chinese = [...flatten(zhCN).keys()].toSorted();

    expect(chinese).toStrictEqual(english);
  });

  test("没有把键名原样写成文案", () => {
    for (const [lang, catalog] of [
      ["en-US", enUS],
      ["zh-CN", zhCN],
    ] as const) {
      for (const [key, text] of flatten(catalog)) {
        expect(`${lang} ${key} = ${text}`).not.toBe(`${lang} ${key} = ${key}`);
      }
    }
  });
});
