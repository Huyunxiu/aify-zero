import type { AgentToolSet } from "@workspace/agent";
import {
  AgentTurnBuilder,
  isAgentReasoningPart,
  isAgentTextPart,
} from "@workspace/agent-client";
import type { AgentStreamEvent, AgentTurn } from "@workspace/agent-client";
import { parseJsonEventStream } from "ai";
import * as React from "react";

export type UseAgentSessionOptions = {
  id: string;
  api: string;
  turns: AgentTurn<AgentToolSet>[];
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
};

type AgentSessionStore = {
  subscribe: (onStoreChange: () => void) => () => void;
  getTurns: () => AgentTurn<AgentToolSet>[];
  getStatus: () => AgentSessionStatus;
  getError: () => Error | undefined;
  sendTurns: (options: SendTurnsOptions) => Promise<void>;
  dispose: () => void;
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * Compensates for `AgentTurnBuilder` treating `abort` and `error` events as
 * no-ops: without this, an interrupted turn stays `status: "streaming"` forever
 * and the UI keeps reporting that it is still working.
 *
 * `pendingTurns` / `pendingParts` are public, and the `turn.finish` / `*`.end`
 * events remove entries from them, so they hold exactly the objects that never
 * finished. Settling those is enough, and it is a no-op for a stream that ended
 * properly.
 *
 * `turn.status` is a union of string literals, so a plain assignment is enough;
 * note that comparing it first would narrow the union and turn the assignment
 * into a type error. Tool parts run their own state machine and are left alone.
 */
const settleUnfinished = (
  builder: AgentTurnBuilder<AgentToolSet>,
  outcome: "aborted" | "error"
): void => {
  for (const turn of builder.pendingTurns.values()) {
    turn.status = outcome;
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
  turns,
}: UseAgentSessionOptions): AgentSessionStore {
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
  }: SendTurnsOptions): Promise<void> => {
    // One request at a time: a newer call takes over and cancels the older one.
    active?.abort();
    const controller = new AbortController();
    active = controller;

    const builder = new AgentTurnBuilder<AgentToolSet>({ turns: nextTurns });

    const publish = (): void => {
      currentTurns = [...builder.turns];
      notify();
    };

    // Surface the caller's turns straight away, so a new user turn is visible
    // before the first event arrives.
    currentError = undefined;
    status = "submitted";
    publish();

    const forwardAbort = (): void => controller.abort();

    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    let failure: Error | undefined;
    let aborted = false;

    try {
      const response = await fetch(api, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: id, turns: nextTurns }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(responseBody || "Failed to fetch the chat response.");
      }

      if (!response.body) {
        throw new Error("The response body is empty.");
      }

      // The response has arrived, so the model is streaming — even if the first
      // event is still in flight.
      if (active === controller) {
        setStatus("streaming");
      }

      const reader = parseJsonEventStream<AgentStreamEvent<AgentToolSet>>({
        stream: response.body,
        // `schema` is required by the signature but optional at runtime, where
        // a null schema yields the unvalidated JSON as-is.
        schema: undefined as any,
      }).getReader();

      try {
        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          if (!value.success) {
            throw value.error;
          }

          await builder.push(value.value);

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
        publish();
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
  turns,
}: UseAgentSessionOptions): UseAgentSessionResponse {
  const storeRef = React.useRef<AgentSessionStore | null>(null);
  const storeIdRef = React.useRef(id);

  // Same as `useChat`: `turns` is only an initial value, read on mount and
  // whenever the session id changes.
  if (storeRef.current === null || storeIdRef.current !== id) {
    storeIdRef.current = id;
    storeRef.current = createAgentSessionStore({ id, api, turns });
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
