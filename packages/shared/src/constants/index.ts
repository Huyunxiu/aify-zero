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
export const LANGUAGE_HEADER = "accept-language";

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
};

export const inDevelopment = process.env.NODE_ENV === "development";
