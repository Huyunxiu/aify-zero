import type { Language } from "./language";

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
