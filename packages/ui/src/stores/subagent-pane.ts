import { create } from "zustand";

/**
 * The subagent whose transcript the second pane is showing.
 *
 * Kept outside React because the two ends of it are in different trees: the
 * `task` row that is clicked is deep inside the session being read, and the
 * pane that shows what that row delegated to stands beside the session rather
 * than inside it. Nothing owns both, so nothing can pass it down.
 *
 * `null` is the pane's own state rather than "nothing selected": with no
 * subagent to read it holds a session of its own, the way it did before any of
 * this existed.
 */
type SubagentPaneState = {
  /** The child session the pane is reading, or null for the pane's own. */
  sessionId: string | null;
  select: (sessionId: string) => void;
  clear: () => void;
};

export const useSubagentPane = create<SubagentPaneState>((set) => ({
  sessionId: null,
  select: (sessionId) => set({ sessionId }),
  clear: () => set({ sessionId: null }),
}));
