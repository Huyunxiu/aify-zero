import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import type { BotSettings } from "./types";

/**
 * One Bot's settings, handed down from the Bot layout to whichever section is on
 * screen. The layout owns the query, so switching sections never refetches the
 * Bot and never shows the loading state again.
 */
const BotSettingsContext = createContext<BotSettings | null>(null);

export function BotSettingsProvider({
  value,
  children,
}: {
  readonly value: BotSettings;
  readonly children: ReactNode;
}) {
  return (
    <BotSettingsContext.Provider value={value}>
      {children}
    </BotSettingsContext.Provider>
  );
}

export function useBotSettings(): BotSettings {
  const value = useContext(BotSettingsContext);

  if (!value) {
    throw new Error("useBotSettings must render inside a Bot settings route.");
  }

  return value;
}
