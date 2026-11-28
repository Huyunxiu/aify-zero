/**
 * Reads which subagent the session panel shows, and changes that choice.
 *
 * The choice lives in the address, so this hook is the only place that reads and
 * writes it: the `create-subagent` row writes it when the reader clicks, and the
 * panel reads it when it mounts. Two readers of one address would drift apart, so both
 * go through here.
 *
 * The address records a selection, not a visibility: it says which subagent the
 * reader still wants, whether or not its tab is the active one. Closing that tab
 * is what takes the choice back.
 */
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { readSubagentId, validateSessionSearch } from "../lib/session-search";
import type { SessionSearch } from "../lib/session-search";

export type SubagentAddress = {
  /** The subagent the address names; undefined when it names none. */
  readonly selectedSubagentSessionId: string | undefined;
  /**
   * Points the address at a subagent.
   *
   * Clicking the same subagent again is not a new step in history.
   */
  readonly select: (subagentSessionId: string) => void;
  /** Takes the choice back. */
  readonly clear: () => void;
};

export function useSubagentAddress(): SubagentAddress {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const params: Record<string, unknown> = useParams({ strict: false });
  const navigate = useNavigate();

  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId : undefined;

  // The panel belongs to a session that has an id in its address. The session
  // list screen has no panel, so it names no subagent: an id there would light
  // the row up with nothing to show for it.
  const selectedSubagentSessionId =
    sessionId === undefined ? undefined : readSubagentId(search);

  const writeAddress = React.useCallback(
    (next: SessionSearch) => {
      if (sessionId === undefined) {
        return;
      }

      // Only the first selection adds a step to history. A later one replaces
      // it, so Back returns to this session and does not walk through the rows
      // the reader inspected. Clearing a choice never adds a step.
      const replace =
        next.subagent === undefined || selectedSubagentSessionId !== undefined;

      void navigate({
        params: { sessionId },
        replace,
        search: next,
        to: "/sessions/$sessionId",
      });
    },
    [navigate, selectedSubagentSessionId, sessionId]
  );

  const select = React.useCallback(
    (subagentSessionId: string) => {
      writeAddress({
        ...validateSessionSearch(search),
        subagent: subagentSessionId,
      });
    },
    [search, writeAddress]
  );

  const clear = React.useCallback(() => {
    writeAddress({ ...validateSessionSearch(search), subagent: undefined });
  }, [search, writeAddress]);

  return { clear, select, selectedSubagentSessionId };
}
