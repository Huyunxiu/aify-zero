// local storage
export const LOCAL_STORAGE_KEYS = {
  LANGUAGE: "lang",
  THEME: "theme",
  MODEL_ID: "model-id",
  MODEL_EFFORT: "model-effort",
};

// languages
export interface LanguageOption {
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
] as const satisfies LanguageOption[];

/** A language tag this project ships translations for. */
export type Language = (typeof LanguageOptions)[number]["key"];

export const SUPPORTED_LANGUAGES: Language[] = LanguageOptions.map(
  (option) => option.key
);

export const DEFAULT_LANGUAGE: Language = "en-US";

/**
 * Header the UI puts its current language on: the oRPC link writes it, the
 * server's language detector reads it. Lives here so the two cannot drift
 * apart.
 *
 * Not `accept-language`: browsers own that one — it is on the forbidden header
 * list — so it cannot carry a choice made in our own settings.
 */
export const LANGUAGE_HEADER = "x-aify-language";

// model effort
export const ModelEffort = {
  Default: "default",
  Off: "off",
  Low: "low",
  Medium: "medium",
  High: "high",
  Ultra: "ultra",
} as const;

export type ModelEffort = (typeof ModelEffort)[keyof typeof ModelEffort];

export const MODEL_EFFORT_LABELS: readonly ModelEffort[] = [
  ModelEffort.Default,
  ModelEffort.Off,
  ModelEffort.Low,
  ModelEffort.Medium,
  ModelEffort.High,
  ModelEffort.Ultra,
];

// ipc
export const IPC_CHANNELS = {
  START_IPC_CLIENT: "start-ipc-client",
  START_IPC_SERVER: "start-ipc-server",
  /** 主进程 -> 渲染端的 API server 状态推送。 */
  SERVER_STATUS: "server-status",
  /** 运行时切换 API server（停内置、改用外部 origin）。 */
  USE_SERVER: "use-server",
};

/**
 * Absolute path to a staged ripgrep binary.
 *
 * Packaging cannot put an executable inside a JS bundle or an asar archive, so
 * `apps/desktop` and `apps/server` copy the binary next to the app and point
 * this variable at it. The agent's grep/glob tools prefer this path over `rg`
 * from `PATH`, which keeps them on the shipped version everywhere.
 */
export const RIPGREP_PATH_ENV = "AIFY_RIPGREP_PATH";

export const inDevelopment = process.env.NODE_ENV === "development";

/**
 * 独立 API server 的默认监听地址与端口。`apps/server`、桌面自启的内置
 * server、桌面 attach 的默认目标和 Vite 的 `/api` 代理都从这里取，避免
 * 多处各写一个 `127.0.0.1:18086`。
 */
export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 18_086;

/** apps/web 的开发服务器端口；桌面反代也用同一个值。 */
export const DEFAULT_WEB_PORT = 3000;
