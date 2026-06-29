export interface Language {
  key: string;
  nativeName: string;
}

export const LanguageOptions = [
  {
    key: "en-US",
    nativeName: "English",
  },
  {
    key: "zh-CN",
    nativeName: "中文",
  },
] as const satisfies Language[];
