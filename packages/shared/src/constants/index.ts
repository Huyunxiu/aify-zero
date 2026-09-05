// local storage
export const LOCAL_STORAGE_KEYS = {
  LANGUAGE: "lang",
  THEME: "theme",
  MODEL_ID: "model-id",
  MODEL_EFFORT: "model-effort",
};

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
