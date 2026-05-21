import { LOCAL_STORAGE_KEYS } from "@workspace/shared/constants";
import { i18n, isLang } from "@workspace/shared/i18n";
import type { Lang } from "@workspace/shared/i18n";

export function getCurrentLanguage(): Lang {
  const localLang = localStorage.getItem(LOCAL_STORAGE_KEYS.LANGUAGE);
  if (isLang(localLang)) {
    return localLang;
  }

  return i18n.language as Lang;
}

export function updateAppLanguage(lang: string) {
  localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, lang);
  document.documentElement.lang = lang;
  void i18n.changeLanguage(lang);
}
