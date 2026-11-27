import { composeSubagentNotice, subagentTypeOf } from "@workspace/agent";
import type { NoticeWriter } from "@workspace/agent";
import {
  SUBAGENT_NOTICE,
  SUBAGENT_NOTICE_INBOX_KIND,
} from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

/** The slice of the store this file reads: a row, by id. */
type NoticeStore = {
  getSessionById(sessionId: string): Promise<{
    id: string;
    kind: string;
    metadata: unknown;
    parentSessionId: string | null;
    subagentName: string | null;
  } | null>;
};

/**
 * Announce the subagent runs a previous process left behind.
 *
 * Recovery settles those rows, but the sessions waiting on them do not run in
 * this process yet, so they have no payload and the writer would refuse the
 * notice without a word. Waking the parent first is what makes the queue accept
 * it; that ordering is this caller's job, not the writer's.
 */
export async function reportRecoveredSubagents({
  recovered,
  store,
  notices,
  wake,
}: {
  recovered: readonly { sessionId: string }[];
  store: NoticeStore;
  notices: NoticeWriter;
  wake: (sessionId: string) => void;
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

    const { parentSessionId } = row;
    const name = row.subagentName ?? row.id;

    try {
      wake(parentSessionId);
    } catch (error) {
      logger.warn(
        `[subagent-notices] could not wake ${parentSessionId}: ${String(error)}`
      );
      continue;
    }

    await notices.write({
      sessionId: parentSessionId,
      text: composeSubagentNotice({
        parentSessionId,
        sessionId: row.id,
        name,
        subagentType: subagentTypeOf(row.metadata),
        status: "error",
        report: "",
      }),
      dedupeKey: `${SUBAGENT_NOTICE_INBOX_KIND}:${row.id}`,
      form: SUBAGENT_NOTICE,
    });
  }
}
