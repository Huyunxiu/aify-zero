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

export const inDevelopment = process.env.NODE_ENV === "development";
