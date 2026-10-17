import type { AgentToolSet } from "@workspace/agent";
import { AgentTurnBuilder, isAgentToolPart } from "@workspace/agent-client";
import type {
  AgentStreamEvent,
  AgentTurn,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import { parseJsonEventStream } from "ai";
import * as React from "react";
import throttle from "throttleit";

export type UseAgentSessionOptions = {
  id: string;
  api?: string;
  apiStream?: (
    options: {
      sessionId: string;
      turns: AgentTurn<AgentToolSet>[];
      abortSignal: AbortSignal;
      approvals?: TextStreamToolApprovalResponseEvent[];
    } & Record<string, unknown>
  ) => Promise<ReadableStream | undefined>;
  /**
   * Stops the turn the session is running on the server. Located by
   * `sessionId`, not by a stream id — the client holds only the session's.
   *
   * Read when the store is created, like `api` and `apiStream`.
   */
  apiStop?: (options: { sessionId: string }) => Promise<unknown>;
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
  /**
   * Attaches to the turn a session is already running, for a page that arrived
   * mid-turn.
   */
  resume: (options: ResumeOptions) => Promise<void>;
  /**
   * Answers a call a turn was held on, and resumes the turn with that answer.
   *
   * The call is answered on screen at once, and the answer is then sent like
   * any other turn; the turn, the step and the tool call it belongs to are read
   * off the transcript from the approval id alone. What a send needs beyond the
   * transcript — the model, the effort — travels in `payload`.
   */
  addToolApprovalResponse: (
    options: AddToolApprovalResponseOptions
  ) => Promise<void>;
  /**
   * Stops the turn the session is running, on both ends: the read this store is
   * doing, and the server's turn, which outlives it.
   */
  stop: () => Promise<void>;
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

type ResumeOptions = {
  /**
   * The running turn's events, which begin at its `turn.start`: the server
   * replays what the turn has produced so far and then follows it live, so the
   * turn is rebuilt whole rather than joined mid-sentence.
   */
  stream: ReadableStream;
  abortSignal?: AbortSignal;
};

type AddToolApprovalResponseOptions = {
  /**
   * The id of the `approval` on the part being answered — the approval's own
   * id, not the tool call's. Both are on the part, and only this one says which
   * question is being answered.
   */
  approvalId: string;
  /** Whether the call may run. */
  approved: boolean;
  /** Why it was answered this way, recorded with the answer. */
  reason?: string;
  /**
   * Extra fields merged into the request body alongside `sessionId` and
   * `turns`, exactly as {@link SendTurnsOptions.payload}. An answer resumes the
   * held turn, so it needs what any send needs to start one.
   */
  payload?: Record<string, unknown>;
  /**
   * Stops the request carrying the answer. Optional because a newer send
   * cancels the older one on its own, so a throwaway signal is the common
   * value.
   */
  abortSignal?: AbortSignal;
};

/**
 * The held call an answer is addressed to: the three ids the request body names
 * it by, read off the transcript.
 */
type ToolApprovalTarget = {
  turnId: string;
  stepId: string;
  toolCallId: string;
};

type AgentSessionStore = {
  subscribe: (onStoreChange: () => void) => () => void;
  getTurns: () => AgentTurn<AgentToolSet>[];
  getStatus: () => AgentSessionStatus;
  getError: () => Error | undefined;
  sendTurns: (options: SendTurnsOptions) => Promise<void>;
  resume: (options: ResumeOptions) => Promise<void>;
  addToolApprovalResponse: (
    options: AddToolApprovalResponseOptions
  ) => Promise<void>;
  stop: () => Promise<void>;
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
 * Finds the held call an answer belongs to, addressed the way the request body
 * addresses it.
 *
 * An answer names only the approval — which is what the UI has in hand — while
 * resuming the held turn needs the three ids the part sits inside: the turn,
 * the step and the call. Reading them back off the transcript here is what
 * spares every caller from carrying them through the render tree just to hand
 * them straight back.
 *
 * Only a part still holding the question is a target. One whose call has since
 * run has been answered already, and answering it again would name a question
 * the server has moved past.
 */
const findToolApprovalTarget = (
  turns: readonly AgentTurn<AgentToolSet>[],
  approvalId: string
): ToolApprovalTarget | undefined => {
  for (const turn of turns) {
    if (turn.type !== "assistant") {
      continue;
    }

    for (const step of turn.content) {
      for (const part of step.content) {
        if (
          isAgentToolPart(part) &&
          part.state === "approval-requested" &&
          part.approval.id === approvalId
        ) {
          return {
            turnId: turn.id,
            stepId: step.id,
            toolCallId: part.toolCallId,
          };
        }
      }
    }
  }

  return undefined;
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
export function createAgentSessionStore({
  id,
  api,
  apiStream,
  apiStop,
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

  /**
   * `commit` on a leash: at most one snapshot per window while a response
   * streams, so per-token deltas stop forcing a render each. The throttle is
   * consulted inside the body rather than at the call site because the trailing
   * call arrives from a timer that can outlive the request that scheduled it —
   * only `active` says whether those turns still belong on screen, and by then
   * it may name a newer request, or none.
   *
   * `commit` reads `builder.turns` when it runs rather than being handed a
   * snapshot, so a collapsed call publishes the latest state and nothing is
   * lost but the intermediate frames.
   *
   * One instance per request, never one per store: the leading call is the one
   * that fires immediately, and every send has to paint its own turns without
   * waiting out the window the previous send left open.
   */
  const makePublish = (
    controller: AbortController,
    commit: () => void
  ): (() => void) =>
    throttleMs > 0
      ? throttle((): void => {
          if (active === controller) {
            commit();
          }
        }, throttleMs)
      : commit;

  /**
   * Ends a request.
   *
   * Only the current request may write state — one that got superseded stops
   * here rather than clobbering the newer one.
   *
   * A clean end of stream can still leave work unfinished: aborting a fetch may
   * resolve a pending `read()` with `done: true` instead of rejecting it, and
   * the server may close the stream without ever sending `turn.finish`. Whatever
   * is still pending at this point is by definition unfinished, so it is settled
   * as aborted — or as errored when the transport failed outright.
   *
   * `commit`, not `publish`: the settled turns, the status and the error have to
   * land now rather than when a window closes. Clearing `active` above is also
   * what turns any trailing call this request scheduled into a no-op — it must
   * not move below this line, because `notify` runs listeners synchronously and
   * a send re-entered from one would otherwise be clobbered by this request
   * clearing `active` afterwards.
   */
  const settle = ({
    builder,
    controller,
    failure,
    aborted,
    commit,
  }: {
    builder: AgentTurnBuilder<AgentToolSet>;
    controller: AbortController;
    failure: Error | undefined;
    aborted: boolean;
    commit: () => void;
  }): void => {
    if (active !== controller) {
      return;
    }

    active = null;
    builder.settle(failure && !aborted ? "error" : "aborted");
    currentError = failure;
    status = failure ? "error" : "ready";
    commit();
  };

  /**
   * Reads a turn's events into `builder` until the stream ends, publishing
   * snapshots as they land and settling what the stream left unfinished.
   *
   * Shared by `sendTurns` and `resume`, which differ only in where the stream
   * comes from: a send asks the server for a new turn, a resume attaches to one
   * already running.
   */
  const readInto = async ({
    stream,
    builder,
    controller,
    commit,
    publish,
  }: {
    stream: ReadableStream;
    builder: AgentTurnBuilder<AgentToolSet>;
    controller: AbortController;
    commit: () => void;
    publish: () => void;
  }): Promise<void> => {
    let failure: Error | undefined;
    let aborted = false;

    const reader = stream.getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        const event = value as AgentStreamEvent<AgentToolSet>;
        await builder.push(event);
        emit(event);

        // The guard is repeated inside the throttle, which is what covers the
        // trailing call; this one is what covers the unthrottled branch, where
        // `publish` is `commit`. It also spares a request that is already
        // superseded the timer.
        if (active === controller) {
          publish();
        }
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
      reader.releaseLock();
      settle({ builder, controller, failure, aborted, commit });
    }
  };

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

    const publish = makePublish(controller, commit);

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

    try {
      const body = { sessionId: id, turns: nextTurns, ...payload };
      let stream: ReadableStream | undefined = undefined;
      if (apiStream) {
        stream = await apiStream({ ...body, abortSignal: controller.signal });
        // The stream has been handed over, so the turn is under way — the same
        // transition the `api` branch makes when its response arrives.
        if (stream && active === controller) {
          setStatus("streaming");
        }
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

      // 注意：这里会有工具还未审批完导致 stream 没有的情况
      if (!stream) {
        return;
      }

      await readInto({ stream, builder, controller, commit, publish });
    } catch (error) {
      // Nothing is being read — the request was refused, or the transport died
      // before a stream existed — so the ending is settled here instead.
      settle({
        builder,
        controller,
        failure: controller.signal.aborted ? undefined : toError(error),
        aborted: controller.signal.aborted,
        commit,
      });
    } finally {
      abortSignal.removeEventListener("abort", forwardAbort);
    }
  };

  /**
   * Attaches to a turn that is already running.
   *
   * A page that reloads mid-turn has no stream of its own: the send that started
   * the turn belongs to the page that left, and the turn keeps running without
   * it. Attaching replays the running turn from its start, so seeding a builder
   * with the turns already on screen rebuilds the turn and then follows it live
   * — the turn is read whole rather than joined mid-sentence.
   */
  const resume = async ({
    stream,
    abortSignal,
  }: ResumeOptions): Promise<void> => {
    // Attaching is a request like a send, and takes over from whatever the
    // store was doing.
    active?.abort();
    const controller = new AbortController();
    active = controller;

    const builder = new AgentTurnBuilder<AgentToolSet>({ turns: currentTurns });

    const commit = (): void => {
      currentTurns = [...builder.turns];
      notify();
    };

    const publish = makePublish(controller, commit);

    currentError = undefined;
    status = "streaming";
    commit();

    const forwardAbort = (): void => controller.abort();

    if (abortSignal?.aborted) {
      controller.abort();
    } else {
      abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      await readInto({ stream, builder, controller, commit, publish });
    } finally {
      abortSignal?.removeEventListener("abort", forwardAbort);
    }
  };

  /**
   * Answers a call the turn was held on.
   *
   * The answer lands on screen first. The part is rewritten exactly as a
   * `tool.approval-response` event would rewrite it — same fields, same state —
   * so the question gives way to the answer the moment it is given, rather than
   * when the resumed stream catches up; the stream saying the same thing later
   * is then a rewrite of what is already there. Nothing else about the part
   * moves: the call has not run yet, and only the stream can say that it did.
   *
   * The answer is then sent as a turn of its own — the transcript goes back as
   * it stands, with the answer beside it. No user turn is added: the held turn
   * is already the last one on screen, and the answer belongs to it rather than
   * to a message of its own.
   */
  const addToolApprovalResponse = async ({
    approvalId,
    approved,
    reason,
    payload,
    abortSignal,
  }: AddToolApprovalResponseOptions): Promise<void> => {
    const target = findToolApprovalTarget(currentTurns, approvalId);

    if (!target) {
      // Nothing on screen asked this question — a button left over on a turn
      // that has already moved on lands here, and there is no answer to send.
      return;
    }

    const answeredAt = Date.now();

    const answer = {
      type: "tool.approval-response",
      id: target.toolCallId,
      approvalId,
      approved,
      ...(reason ? { reason } : {}),
      turnId: target.turnId,
      stepId: target.stepId,
      createdAt: answeredAt,
    } satisfies TextStreamToolApprovalResponseEvent;

    // The answer is applied to the transcript through the builder, with the
    // very event the stream would carry. That is what keeps the local answer
    // and a streamed one the same rewrite of the same fields — the part moves
    // to `approval-responded` and nothing else about it moves, because the call
    // has not run and only the stream can say that it did.
    const builder = new AgentTurnBuilder<AgentToolSet>({ turns: currentTurns });
    await builder.push(answer);

    // The rewrite was in place, so the snapshot has to take a new identity for
    // the listeners to see it — the rule every publish here keeps, and the one
    // `useSyncExternalStore` demands of a snapshot.
    currentTurns = [...builder.turns];
    notify();

    await sendTurns({
      turns: currentTurns,
      abortSignal: abortSignal ?? new AbortController().signal,
      payload: {
        ...payload,
        // An answer to a held call travels with the turn it answers. Its
        // presence is what makes the new stream a resumption: the server runs
        // the calls it names before asking the model anything again.
        approvals: [answer],
      },
    });
  };

  /**
   * Stops the turn. Two independent things have to stop: the local read, so the
   * transcript settles now, and the server's turn, which by design outlives the
   * request that asked for it.
   *
   * `active` is deliberately not cleared here — the request's own `finally` owns
   * that, and clearing it early would stop that request from settling the turn.
   */
  const stop = async (): Promise<void> => {
    if (!apiStop) {
      return;
    }

    try {
      await apiStop({ sessionId: id });
    } catch {
      // Stopping a turn that is not running is a no-op, not a failure, and a
      // transport failure here is already covered by the aborted transcript.
    }
  };

  return {
    subscribe,
    getTurns,
    getStatus,
    getError,
    sendTurns,
    resume,
    addToolApprovalResponse,
    stop,
  };
}

export function useAgentSession({
  id,
  api,
  apiStream,
  apiStop,
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
      apiStop,
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

  return {
    turns: currentTurns,
    sendTurns: store.sendTurns,
    resume: store.resume,
    addToolApprovalResponse: store.addToolApprovalResponse,
    stop: store.stop,
    error,
    status,
  };
}
