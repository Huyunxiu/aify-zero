import { create } from "zustand";

interface AppState {
  sessionId: string | undefined;
  setSessionId: (chatId: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  sessionId: undefined,
  setSessionId: (chatId: string) => {
    set(() => ({ sessionId: chatId }));
  },
}));
