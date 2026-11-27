import type {
  AgentUserTurn,
  EnqueueInboxInput,
  InboxItem,
  InboxPayload,
  NoticeForm,
} from "@workspace/agent-client";

import { generateStepId, generateTurnId } from "../utils/id-util";

/**
 * How many times one session may be woken by its own notices.
 *
 * A completion that starts another completion starts a chain nobody asked for.
 * Past this count the notice still queues; it just waits for a person to speak
 * before the model sees it.
 */
const MAX_NOTICE_WAKES = 8;

/** One message a settled background unit of work leaves in its owner's inbox. */
export type NoticeRequest = {
  sessionId: string;
  text: string;
  dedupeKey: string;
  /** Which notice this is. The producer names it; the writer does not guess. */
  form: NoticeForm;
};

/**
 * The one way anything writes a completion notice into a session.
 *
 * It is not the runner: the runner owns it, and so does every agent assembly
 * that may settle something in the background. Two producers depend on this
 * shape today — a settled job and a settled subagent — and neither should have
 * to reach the runner to say so.
 */
export type NoticeWriter = {
  /**
   * Queue one notice.
   *
   * @returns the queued item, or undefined when the session cannot take one.
   * A caller must read undefined as "this will not arrive".
   */
  write(request: NoticeRequest): Promise<InboxItem | undefined>;
  /** Whether the session could take a notice right now. */
  canDeliver(sessionId: string): boolean;
  /** A person spoke: the run of notice-driven wakes starts again. */
  resetBudget(sessionId: string): void;
};

export type NoticeWriterDeps = {
  /** Writes the inbox row. */
  insert(item: EnqueueInboxInput): Promise<InboxItem>;
  /** Whether the session is busy, which decides where the notice is delivered. */
  isBusy(sessionId: string): boolean;
  /**
   * The model configuration the session last ran with.
   *
   * A notice wakes a session into a new run, and a run needs a model; absent
   * this, there is nothing to wake it with.
   */
  payloadOf(sessionId: string): InboxPayload | undefined;
  /** Starts the session, if it is idle. */
  wake(sessionId: string): void;
  /** The runner has stopped taking work: nothing new is accepted. */
  isStopped(): boolean;
  /** A failed write is logged, never thrown: it must not turn a settlement into an error. */
  warn(message: string, error?: unknown): void;
};

export function createNoticeWriter(deps: NoticeWriterDeps): NoticeWriter {
  /** Wakes spent per session since a person last spoke. */
  const spent = new Map<string, number>();

  return {
    async write({ sessionId, text, dedupeKey, form }) {
      const payload = deps.payloadOf(sessionId);
      if (payload === undefined) {
        return;
      }

      const busy = deps.isBusy(sessionId);
      const now = Date.now();
      const turn: AgentUserTurn = {
        id: generateTurnId(),
        type: "user",
        createdAt: now,
        status: "done",
        content: [
          {
            id: generateStepId(),
            type: "user",
            createdAt: now,
            status: "done",
            source: form.source,
            content: [{ type: "text", text, createdAt: now }],
          },
        ],
      };

      let item: InboxItem;
      try {
        item = await deps.insert({
          sessionId,
          kind: form.kind,
          dedupeKey,
          deliverAt: busy ? "step-boundary" : "run-boundary",
          content: turn,
          payload,
        });
      } catch (error: unknown) {
        deps.warn(`[notices] failed to write a notice for ${sessionId}`, error);
        return;
      }

      if (!busy) {
        const used = spent.get(sessionId) ?? 0;
        if (used < MAX_NOTICE_WAKES) {
          spent.set(sessionId, used + 1);
          deps.wake(sessionId);
        }
      }

      return item;
    },

    canDeliver(sessionId) {
      return !deps.isStopped() && deps.payloadOf(sessionId) !== undefined;
    },

    resetBudget(sessionId) {
      spent.delete(sessionId);
    },
  };
}
