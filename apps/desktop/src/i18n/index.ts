import { changeLanguage, init, t as translate } from "i18next";

import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";

/**
 * 主进程的界面语言。
 *
 * 主进程只有托盘菜单这类原生界面，语言和渲染端同源：界面语言变了，渲染端通过
 * `setLanguage` 推过来。两者不一致的时候以推过来的为准——用户可以改，操作
 * 系统语言不能。
 *
 * 键是扁平的，`keySeparator: false`；这样 `DesktopStringKey` 就是这份 JSON 的
 * 字面量联合，写错一个键是类型错误，不会在界面上显示键名。
 */
export const desktopResources = {
  "en-US": enUS,
  "zh-CN": zhCN,
} as const;

export type DesktopLanguage = keyof typeof desktopResources;

export type DesktopStringKey = keyof typeof enUS;

export const DEFAULT_DESKTOP_LANGUAGE: DesktopLanguage = "en-US";

/**
 * 把系统或界面给的语言标签收敛成我们支持的两个。
 *
 * 只按主标签判断：`zh`、`zh-CN`、`zh-Hans` 都是中文；其余一律回落英文，免得
 * 一个没见过的标签让托盘菜单空着。
 *
 * @param value - 例如 `app.getLocale()` 的结果，或渲染端推来的值。
 */
export const resolveDesktopLanguage = (
  value?: string | null
): DesktopLanguage => {
  const normalized = (value ?? "").trim().toLowerCase();

  return normalized.startsWith("zh") ? "zh-CN" : DEFAULT_DESKTOP_LANGUAGE;
};

let current: DesktopLanguage = DEFAULT_DESKTOP_LANGUAGE;

// 同步初始化：主进程第一件事就是建托盘，`t()` 不能等一个 Promise。资源随模块
// 一起加载，`initAsync: false` 让 init 在返回前就完成。
void init({
  fallbackLng: DEFAULT_DESKTOP_LANGUAGE,
  initAsync: false,
  interpolation: { escapeValue: false },
  keySeparator: false,
  lng: current,
  resources: {
    "en-US": { translation: enUS },
    "zh-CN": { translation: zhCN },
  },
});

/**
 * 换语言；返回收敛之后的值。
 *
 * @param value - 渲染端推来的语言，或系统语言。
 */
export const setDesktopLanguage = (value?: string | null): DesktopLanguage => {
  const next = resolveDesktopLanguage(value);

  if (next !== current) {
    current = next;
    void changeLanguage(next);
  }

  return current;
};

/** 当前语言。 */
export const desktopLanguage = (): DesktopLanguage => current;

/**
 * 取一条主进程的文案。
 *
 * @param key - 文案键；只能是 locale 文件里有的那几个。
 */
export const t = (key: DesktopStringKey): string => translate(key);
