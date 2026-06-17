import { create } from "zustand";

interface AppState {
  threadId: string | undefined;
  setThreadId: (chatId: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  threadId: undefined,
  setThreadId: (chatId: string) => {
    set(() => ({ threadId: chatId }));
  },
}));
