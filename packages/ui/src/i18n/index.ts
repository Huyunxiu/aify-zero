import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import enUSCommon from "./locales/en-US/common.json";
import zhCNCommon from "./locales/zh-CN/common.json";

// the translations
// (tip move them in a JSON file and import them,
// or even better, manage them separated from your code: https://react.i18next.com/guides/multiple-translation-files)
export const resources = {
  "en-US": {
    common: enUSCommon,
  },
  "zh-CN": {
    common: zhCNCommon,
  },
} as const;

/**
 * 让 `t("...")` 的键在编译期受检：缺键或拼错键都是类型错误，而不是界面上
 * 原样显示一段键名。
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: { common: (typeof resources)["en-US"]["common"] };
  }
}

export type Lang = keyof typeof resources;

export const LANG_VALUES = Object.keys(resources) as Lang[];

export function isLang(value: string | null): value is Lang {
  if (value === null) {
    return false;
  }

  return LANG_VALUES.includes(value as Lang);
}

export const defaultNS = "common";

export const DEFAULT_LANG = "en-US";

export const i18n = i18next;

export type I18n = typeof i18n;

void i18n.use(initReactI18next).init({
  interpolation: {
    // react already safes from xss
    escapeValue: false,
  },
  // language to use, more information here: https://www.i18next.com/overview/configuration-options#languages-namespaces-resources
  // you can use the i18n.changeLanguage function to change the language manually: https://www.i18next.com/overview/api#changelanguage
  // if you're using a language detector, do not define the lng option
  lng: DEFAULT_LANG,
  ns: [defaultNS],
  resources,
});
