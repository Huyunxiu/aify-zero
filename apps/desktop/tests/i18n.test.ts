import { describe, expect, test } from "vitest";

import {
  DEFAULT_DESKTOP_LANGUAGE,
  desktopResources,
  resolveDesktopLanguage,
  t,
} from "../src/i18n";

describe(resolveDesktopLanguage, () => {
  test("keeps the two languages we ship", () => {
    expect(resolveDesktopLanguage("en-US")).toBe("en-US");
    expect(resolveDesktopLanguage("zh-CN")).toBe("zh-CN");
  });

  test("accepts any label a Chinese system sends", () => {
    expect(resolveDesktopLanguage("zh")).toBe("zh-CN");
    expect(resolveDesktopLanguage("zh-Hans")).toBe("zh-CN");
    expect(resolveDesktopLanguage("ZH-cn")).toBe("zh-CN");
  });

  test("falls back to English for anything else", () => {
    expect(resolveDesktopLanguage("fr-FR")).toBe(DEFAULT_DESKTOP_LANGUAGE);
    expect(resolveDesktopLanguage("")).toBe(DEFAULT_DESKTOP_LANGUAGE);
    expect(resolveDesktopLanguage()).toBe(DEFAULT_DESKTOP_LANGUAGE);
    expect(resolveDesktopLanguage(null)).toBe(DEFAULT_DESKTOP_LANGUAGE);
  });
});

describe("desktop catalogs", () => {
  test("both languages carry the same keys", () => {
    expect(Object.keys(desktopResources["zh-CN"]).toSorted()).toStrictEqual(
      Object.keys(desktopResources["en-US"]).toSorted()
    );
  });

  test("no catalog value is empty", () => {
    for (const catalog of Object.values(desktopResources)) {
      for (const value of Object.values(catalog)) {
        expect(value.trim()).not.toBe("");
      }
    }
  });

  test("t reads the catalog of the current language", () => {
    expect(t("tray.open")).toBe(
      desktopResources[DEFAULT_DESKTOP_LANGUAGE]["tray.open"]
    );
  });
});
