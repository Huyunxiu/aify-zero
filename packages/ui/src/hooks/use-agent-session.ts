import type { AgentToolSet } from "@workspace/agent";
import {
  AgentTurnBuilder,
  isAgentReasoningPart,
  isAgentSessionTitlePart,
  isAgentTextPart,
} from "@workspace/agent-client";
import type { AgentStreamEvent, AgentTurn } from "@workspace/agent-client";
import { parseJsonEventStream } from "ai";
import * as React from "react";
import throttle from "throttleit";

export type UseAgentSessionOptions = {
  id: string;
  api?: string;
  apiStream?: (options: {
    sessionId: string;
    turns: AgentTurn<AgentToolSet>[];
    abortSignal: AbortSignal;
  }) => Promise<ReadableStream | undefined>;
  /**
   * Minimum gap, in milliseconds, between the `turns` snapshots published while
   * a response streams, defaulting to `200`. Every publish hands subscribers a
   * new array, and a text delta arrives per token, so without this the
   * transcript re-renders once per token; the intermediate frames are collapsed
   * and only the latest state is painted. `0` publishes every event.
   *
   * Only the turn snapshots are throttled. `status` and `error` changes and
   * `onEvent` are not, and the last snapshot of a request is always published
   * immediately.
   *
   * Like `api`, this is read when the store is created, so a new value takes
   * effect when the session id changes.
   */
  throttleMs?: number;
  turns: AgentTurn<AgentToolSet>[];
  /**
   * Called for every event as it arrives, before it is folded into the turns.
   * For events that are not part of any turn — the session title — this is the
   * only way to see them.
   */
  onEvent?: (event: AgentStreamEvent<AgentToolSet>) => void;
};

type AgentSessionStatus = "submitted" | "streaming" | "ready" | "error";

export type UseAgentSessionResponse = {
  turns: AgentTurn<AgentToolSet>[];
  sendTurns: (options: SendTurnsOptions) => Promise<void>;
  error: Error | undefined;
  status: AgentSessionStatus;
};

type SendTurnsOptions = {
  turns: AgentTurn<AgentToolSet>[];
  abortSignal: AbortSignal;
  /**
   * Extra fields merged into the request body alongside `sessionId` and
   * `turns`. What a send needs beyond the transcript — the model, the effort —
   * is chosen per message, so it belongs to the call rather than to the hook's
   * options, which are only read when the store is created.
   */
  payload?: Record<string, unknown>;
};

type AgentSessionStore = {
  subscribe: (onStoreChange: () => void) => () => void;
  getTurns: () => AgentTurn<AgentToolSet>[];
  getStatus: () => AgentSessionStatus;
  getError: () => Error | undefined;
  sendTurns: (options: SendTurnsOptions) => Promise<void>;
  dispose: () => void;
};

type AgentSessionStoreOptions = UseAgentSessionOptions & {
  /**
   * Stable indirection onto the latest `onEvent`. The store is created in a
   * render and then outlives it, so capturing the callback directly would pin
   * the first render's closure forever.
   */
  emit: (event: AgentStreamEvent<AgentToolSet>) => void;
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * Pulls the message out of a failed response.
 *
 * A thrown oRPC procedure answers with a JSON body carrying the fields the
 * typed client would have decoded into an `ORPCError`; throwing that text
 * verbatim would put a wall of JSON in the error bubble.
 */
const readErrorMessage = async (response: Response): Promise<string> => {
  const body = await response.text();

  if (!body) {
    return "Failed to fetch the chat response.";
  }

  try {
    const parsed: unknown = JSON.parse(body);
    const message = (parsed as { message?: unknown } | null)?.message;
    if (typeof message === "string") {
      return message;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }

  return body;
};

/**
 * Compensates for a stream that ended without the server's `turn.finish`:
 * without this, an interrupted turn stays `status: "streaming"` forever and the
 * UI keeps reporting that it is still working.
 *
 * `pendingTurns` / `pendingSteps` / `pendingParts` are public, and the
 * `turn.finish` / `step.finish` / `*`.end events remove entries from them, so
 * they hold exactly the objects that never finished. Settling those is enough,
 * and it is a no-op for a stream that ended properly, where the ending arrives
 * on the finish event instead.
 *
 * `status` is a union of string literals, so a plain assignment is enough; note
 * that comparing it first would narrow the union and turn the assignment into a
 * type error. Tool parts run their own state machine and are left alone.
 */
const settleUnfinished = (
  builder: AgentTurnBuilder<AgentToolSet>,
  outcome: "aborted" | "error"
): void => {
  for (const turn of builder.pendingTurns.values()) {
    turn.status = outcome;
  }

  for (const step of builder.pendingSteps.values()) {
    step.status = outcome;
  }

  for (const part of builder.pendingParts.values()) {
    if (isAgentTextPart(part) || isAgentReasoningPart(part)) {
      part.state = "done";
    }
  }
};

/**
 * The mutable half of the hook, kept free of React so it can be driven
 * directly.
 *
 * `AgentTurnBuilder` mutates the turns array in place and never changes its
 * identity, so each snapshot published here is a shallow copy taken right after
 * a mutation — the identity changes exactly when the content does, which is
 * what `useSyncExternalStore` requires of a snapshot.
 */
function createAgentSessionStore({
  id,
  api,
  apiStream,
  throttleMs = 200,
  turns,
  emit,
}: AgentSessionStoreOptions): AgentSessionStore {
  const listeners = new Set<() => void>();

  let currentTurns = turns;
  let status: AgentSessionStatus = "ready";
  let currentError: Error | undefined;
  let active: AbortController | null = null;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setStatus = (next: AgentSessionStatus): void => {
    if (status === next) {
      return;
    }

    status = next;
    notify();
  };

  const subscribe = (onStoreChange: () => void): (() => void) => {
    listeners.add(onStoreChange);

    return () => {
      listeners.delete(onStoreChange);
    };
  };

  const getTurns = (): AgentTurn<AgentToolSet>[] => currentTurns;
  const getStatus = (): AgentSessionStatus => status;
  const getError = (): Error | undefined => currentError;

  const sendTurns = async ({
    turns: nextTurns,
    abortSignal,
    payload,
  }: SendTurnsOptions): Promise<void> => {
    // One request at a time: a newer call takes over and cancels the older one.
    active?.abort();
    const controller = new AbortController();
    active = controller;

    const builder = new AgentTurnBuilder<AgentToolSet>({ turns: nextTurns });

    const commit = (): void => {
      currentTurns = [...builder.turns];
      notify();
    };

    // `publish` is `commit` on a leash: at most one snapshot per window while a
    // response streams, so per-token deltas stop forcing a render each. The
    // throttle is consulted inside the body rather than at the call site
    // because the trailing call arrives from a timer that can outlive the
    // request that scheduled it — only `active` says whether those turns still
    // belong on screen, and by then it may name a newer request, or none.
    //
    // `commit` reads `builder.turns` when it runs rather than being handed a
    // snapshot, so a collapsed call publishes the latest state and nothing is
    // lost but the intermediate frames.
    //
    // One instance per request, never one per store: the leading call is the
    // one that fires immediately, and every send has to paint its own turns
    // without waiting out the window the previous send left open.
    const publish =
      throttleMs > 0
        ? throttle((): void => {
          if (active === controller) {
            commit();
          }
        }, throttleMs)
        : commit;

    // Surface the caller's turns straight away, so a new user turn is visible
    // before the first event arrives. `commit`, not `publish`: this is the
    // state the throttle exists to hold back, and `status` above rides on its
    // notify, so it must not wait out a window.
    currentError = undefined;
    status = "submitted";
    commit();

    const forwardAbort = (): void => controller.abort();

    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    let failure: Error | undefined;
    let aborted = false;

    try {
      const body = { sessionId: id, turns: nextTurns, ...payload };
      let stream: ReadableStream | undefined = undefined;
      if (apiStream) {
        stream = await apiStream({ ...body, abortSignal: controller.signal });
      } else if (api) {
        const response = await fetch(api, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }

        if (!response.body) {
          throw new Error("The response body is empty.");
        }

        // The response has arrived, so the model is streaming — even if the first
        // event is still in flight.
        if (active === controller) {
          setStatus("streaming");
        }

        stream = parseJsonEventStream<AgentStreamEvent<AgentToolSet>>({
          stream: response.body,
          // `schema` is required by the signature but optional at runtime, where
          // a null schema yields the unvalidated JSON as-is.
          schema: undefined as any,
        });
      }

      if (!stream) {
        throw new Error("streaming is null.");
      }

      const reader = stream.getReader();

      try {
        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          await builder.push(value);
          emit(value);

          // The guard is repeated inside the throttle, which is what covers
          // the trailing call; this one is what covers the unthrottled branch,
          // where `publish` is `commit`. It also spares a request that is
          // already superseded the timer.
          if (active === controller) {
            publish();
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      // An aborted fetch or stream rejects with an `AbortError`; that is a
      // cancellation, not a failure.
      if (controller.signal.aborted) {
        aborted = true;
      } else {
        failure = toError(error);
      }
    } finally {
      abortSignal.removeEventListener("abort", forwardAbort);

      // Only the current request may write state — a request that got
      // superseded stops here rather than clobbering the newer one.
      if (active === controller) {
        active = null;
        // A clean end of stream can still leave work unfinished: aborting a
        // fetch may resolve a pending `read()` with `done: true` instead of
        // rejecting it, and the server may close the stream without ever
        // sending `turn.finish`. Whatever is still pending at this point is by
        // definition unfinished, so it is settled as aborted.
        settleUnfinished(builder, failure && !aborted ? "error" : "aborted");
        currentError = failure;
        status = failure ? "error" : "ready";
        // `commit`, not `publish`: the settled turns, the status and the error
        // have to land now rather than when a window closes. Clearing `active`
        // above is also what turns any trailing call this request scheduled
        // into a no-op — it must not move below this line, because `notify`
        // runs listeners synchronously and a send re-entered from one would
        // otherwise be clobbered by this request clearing `active` afterwards.
        commit();
      }
    }
  };

  const dispose = (): void => {
    active = null;
  };

  return { subscribe, getTurns, getStatus, getError, sendTurns, dispose };
}

export function useAgentSession({
  id,
  api,
  apiStream,
  throttleMs,
  turns,
  onEvent,
}: UseAgentSessionOptions): UseAgentSessionResponse {
  const storeRef = React.useRef<AgentSessionStore | null>(null);
  const storeIdRef = React.useRef(id);
  const onEventRef = React.useRef(onEvent);
  onEventRef.current = onEvent;

  const emit = React.useCallback((event: AgentStreamEvent<AgentToolSet>) => {
    onEventRef.current?.(event);
  }, []);

  // Same as `useChat`: `turns` is only an initial value, read on mount and
  // whenever the session id changes.
  if (storeRef.current === null || storeIdRef.current !== id) {
    storeIdRef.current = id;
    storeRef.current = createAgentSessionStore({
      id,
      api,
      apiStream,
      throttleMs,
      turns,
      emit,
    });
  }

  const store = storeRef.current;

  // Three subscriptions over a single listener set, mirroring `useChat`.
  const currentTurns = React.useSyncExternalStore(
    store.subscribe,
    store.getTurns,
    store.getTurns
  );
  const status = React.useSyncExternalStore(
    store.subscribe,
    store.getStatus,
    store.getStatus
  );
  const error = React.useSyncExternalStore(
    store.subscribe,
    store.getError,
    store.getError
  );

  React.useEffect(() => (): void => store.dispose(), [store]);

  return { turns: currentTurns, sendTurns: store.sendTurns, error, status };
}
