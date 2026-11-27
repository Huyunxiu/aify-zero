import type { AgentRunner } from "@workspace/agent";
import type { NoticeForm } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

/**
 * One message a settled background unit of work leaves in its owner's inbox.
 *
 * The runner decides whether it can be delivered at all; the dedupe key is what
 * stops a retry from posting the same settlement twice.
 */
export type CompletionNotice = {
  sessionId: string;
  text: string;
  dedupeKey: string;
  /** Which kind of notice this is: the producer's, never the queue's guess. */
  form: NoticeForm;
};

/** What the runner answers with when a notice is queued. */
type QueuedNotice = ReturnType<AgentRunner["enqueueNotice"]>;

export type CompletionNotifier = {
  /**
   * Queues one notice, or answers undefined when it cannot be queued at all.
   *
   * A caller must read undefined as "this will not arrive", and treat it the way
   * it treats any other failed delivery.
   */
  queue(notice: CompletionNotice): QueuedNotice | undefined;
};

/**
 * The one place a completion notice is handed to the runner.
 *
 * A settled job and a settled subagent both leave through here, so queueing,
 * deduplicating and reporting a failed delivery are written once. The runner is
 * read at call time because the subagent producer is built before the runner is.
 *
 * @param getRunner - The runner, or undefined before it exists.
 * @param producer - The prefix a failed delivery logs under.
 */
export const createCompletionNotifier = (
  getRunner: () => AgentRunner | undefined,
  producer: string
): CompletionNotifier => ({
  queue(notice) {
    const runner = getRunner();

    if (runner === undefined || !runner.canDeliverNotice(notice.sessionId)) {
      return;
    }

    return runner.enqueueNotice(notice).catch((error: unknown): undefined => {
      logger.warn(
        `[${producer}] failed to deliver a notice for ${notice.sessionId}: ${String(error)}`
      );
      return undefined;
    });
  },
});
