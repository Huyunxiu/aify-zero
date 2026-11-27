import { composeSubagentNotice, subagentTypeOf } from "@workspace/agent";
import type {
  AgentRunner,
  SubagentNotifier,
  SubagentSettlement,
} from "@workspace/agent";
import { logger } from "@workspace/shared/logger";

/** The inbox kind a settled subagent writes, so a retry cannot post the same notice twice. */
export const SUBAGENT_NOTICE_INBOX_KIND = "subagent-settled";

/** The slice of the store this adapter reads: a row, by id. */
type NoticeStore = {
  getSessionById(sessionId: string): Promise<{
    id: string;
    kind: string;
    metadata: unknown;
    parentSessionId: string | null;
    subagentName: string | null;
  } | null>;
};

export type SubagentNoticeDeps = {
  store: NoticeStore;
};

export type SubagentNoticeAdapter = SubagentNotifier & {
  /**
   * Hand the runner over after it is built.
   *
   * The runner is built with the agent factory that needs this adapter, so the
   * two cannot be constructed in one order. Binding after both exist keeps one
   * direction of dependency.
   */
  bind(runner: AgentRunner): void;
  /**
   * Announce the subagent runs a previous process left behind.
   *
   * Recovery already settles those rows; without this, the sessions waiting on
   * them never learn that the bell will not ring.
   */
  reportRecovered(recovered: readonly { sessionId: string }[]): Promise<void>;
};

/**
 * Turns a subagent settlement into one completion notice in its parent's inbox.
 *
 * It follows the job notice path: the runner decides whether the notice can be
 * delivered at all, and an idle session is woken by the item itself.
 */
export const createSubagentNoticeAdapter = ({
  store,
}: SubagentNoticeDeps): SubagentNoticeAdapter => {
  let runner: AgentRunner | undefined;

  const deliver = (settlement: SubagentSettlement): void => {
    const bound = runner;
    if (bound === undefined) {
      return;
    }
    if (!bound.canDeliverNotice(settlement.parentSessionId)) {
      return;
    }

    void bound
      .enqueueNotice({
        sessionId: settlement.parentSessionId,
        text: composeSubagentNotice(settlement),
        dedupeKey: `${SUBAGENT_NOTICE_INBOX_KIND}:${settlement.sessionId}`,
      })
      .catch((error: unknown) => {
        logger.warn(
          `[subagent-notices] failed to deliver a notice for ${settlement.sessionId}: ${String(error)}`
        );
      });
  };

  return {
    deliver,

    bind(next) {
      runner = next;
    },

    async reportRecovered(recovered) {
      for (const outcome of recovered) {
        const row = await store.getSessionById(outcome.sessionId);

        if (
          row === null ||
          row.kind !== "subagent" ||
          row.parentSessionId === null
        ) {
          continue;
        }

        deliver({
          parentSessionId: row.parentSessionId,
          sessionId: row.id,
          name: row.subagentName ?? row.id,
          subagentType: subagentTypeOf(row.metadata),
          status: "error",
          report: "",
        });
      }
    },
  };
};
