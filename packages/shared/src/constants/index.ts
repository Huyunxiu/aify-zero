// local storage
export const LOCAL_STORAGE_KEYS = {
  LANGUAGE: "lang",
  THEME: "theme",
};

// ipc
export const IPC_CHANNELS = {
  START_IPC_CLIENT: "start-ipc-client",
  START_IPC_SERVER: "start-ipc-server",
};

export type IpcChannels = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const ENVIRONMENT_VARIABLES = {
  NODE_ENV: process.env.NODE_ENV,
};

export const inDevelopment = ENVIRONMENT_VARIABLES.NODE_ENV === "development";
