import {
  AgentSession,
  readSubagentResult,
  settledStatus,
  subagentNoticeRequest,
  subagentTypeOf,
} from "@workspace/agent";
import type { NoticeWriter, TurnRecord } from "@workspace/agent";
import type { InboxPayload } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

/** The slice of the store this file reads: a row, and a session's turns. */
type NoticeStore = {
  getSessionById(sessionId: string): Promise<{
    id: string;
    kind: string;
    metadata: unknown;
    parentSessionId: string | null;
    subagentName: string | null;
    lastPayload: InboxPayload | null;
  } | null>;
  getBranchTurns(sessionId: string): Promise<TurnRecord[]>;
};

/**
 * Announce the subagent runs a previous process left behind.
 *
 * The runs are settled before this call; the sessions waiting on them have no
 * way to know. This process may never have run the parent, so it has no model
 * configuration in memory — the row keeps the last one it ran with, which is
 * what lets the notice wake it (a timer carries the same kind of snapshot).
 *
 * A parent with no stored payload is skipped with a warning: it is a session
 * that has not run since this column existed, so there is nothing to wake it
 * with and nothing to tell it.
 */
export async function reportRecoveredSubagents({
  recovered,
  store,
  notices,
}: {
  recovered: readonly { sessionId: string }[];
  store: NoticeStore;
  notices: NoticeWriter;
}): Promise<void> {
  for (const outcome of recovered) {
    const row = await store.getSessionById(outcome.sessionId);

    if (
      row === null ||
      row.kind !== "subagent" ||
      row.parentSessionId === null
    ) {
      continue;
    }

    const parent = await store.getSessionById(row.parentSessionId);
    if (parent === null || parent.lastPayload === null) {
      logger.warn(
        `[subagent-notices] ${row.parentSessionId} has no model to wake with; its notice is skipped`
      );
      continue;
    }

    const turns = AgentSession.toAgentTurns(await store.getBranchTurns(row.id));
    const { report, status } = readSubagentResult(turns);

    await notices.write({
      ...subagentNoticeRequest({
        parentSessionId: row.parentSessionId,
        sessionId: row.id,
        name: row.subagentName ?? row.id,
        subagentType: subagentTypeOf(row.metadata),
        // A crash does not make every run a failure: one that had answered and
        // only failed to clear its marker reads as `done`. An empty answer still
        // settles as an error, which is the rule a live settlement uses.
        status: settledStatus(status, report),
        report,
        dropped: 0,
      }),
      payload: parent.lastPayload,
    });
  }
}
