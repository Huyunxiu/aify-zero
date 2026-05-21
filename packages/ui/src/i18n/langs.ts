export interface Language {
  key: string;
  nativeName: string;
}

export default [
  {
    key: "en-US",
    nativeName: "English",
  },
  {
    key: "zh-CN",
    nativeName: "中文",
  },
] as const satisfies Language[];
