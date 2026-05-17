// local storage
export const LOCAL_STORAGE_KEYS = {
  LANGUAGE: "lang",
  THEME: "theme",
};

// ipc
export const IPC_CHANNELS = {
  START_IPC_SERVER: "start-ipc-server",
};

export type IpcChannels = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// theme
export const ThemeMode = {
  Dark: "dark",
  Light: "light",
  System: "system",
} as const;

export type ThemeMode = (typeof ThemeMode)[keyof typeof ThemeMode];
