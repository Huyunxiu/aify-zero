import {
  AgentTurnAssembler,
  findToolApprovalRequests,
  formatSessionCursor,
  isAgentToolPart,
} from "@workspace/agent-client";
import type {
  AgentStreamEvent,
  AgentToolSet,
  AgentTurn,
  AgentUserTurn,
  ApprovalPolicy,
  InboxItem,
  JSONObject,
  SessionCursor,
  SessionStreamEvent,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import type { ModelRef } from "@workspace/shared/model";
import { nanoid } from "nanoid";
import throttle from "throttleit";

/** Handoff mode when submitting a turn during an active Run. */
export type SubmitMode = "steering" | "followup";

/**
 * What a Stop does to the subagents a session started.
 *
 * Absent means the default: the stop takes them with it. `keepSubagents` ends
 * only this run, and the children report when they finish.
 */
export type StopOptions = {
  readonly keepSubagents?: boolean;
};

/** Typed host configuration sent with a turn submission or approval response. */
export type SubmitPayload = {
  readonly model: ModelRef;
  readonly modelEffort?: string;
  readonly botId?: string;
  readonly projectId?: string | null;
  readonly approvalPolicy?: ApprovalPolicy;
};

export type SubmitOptions = {
  readonly turn: AgentUserTurn;
  /** Meaningful only while a run is active; idle submits go directly. */
  readonly mode?: SubmitMode;
  readonly payload: SubmitPayload;
};

export type AddToolApprovalResponseOptions = {
  /**
   * The id of the `approval` on the part being answered — the approval's own
   * id, not the tool call's.
   */
  readonly approvalId: string;
  /** Whether the call may run. */
  readonly approved: boolean;
  /** Why it was answered this way, recorded with the answer. */
  readonly reason?: string;
  /**
   * Opaque, JSON-serializable data to keep with the answer.
   */
  readonly data?: JSONObject;
  readonly payload: SubmitPayload;
  readonly abortSignal?: AbortSignal;
};

export type SendSessionInput = {
  readonly sessionId: string;
  readonly turns: AgentTurn<AgentToolSet>[];
  readonly abortSignal: AbortSignal;
  readonly approvals?: TextStreamToolApprovalResponseEvent[];
  readonly payload: SubmitPayload;
};

/** Client port for a session's durable Inbox. */
export type InboxTransport = {
  list: (input: { sessionId: string }) => Promise<InboxItem[]>;
  enqueue: (input: {
    sessionId: string;
    dedupeKey: string;
    mode: SubmitMode;
    turn: AgentUserTurn;
    model: ModelRef;
    modelEffort?: string;
    projectId?: string;
  }) => Promise<{ item: InboxItem }>;
  cancel: (input: { sessionId: string; itemId: string }) => Promise<unknown>;
  clear: (input: { sessionId: string }) => Promise<unknown>;
};

/** Optional write operations for interactive sessions; omitted on read-only views. */
export type SessionWriteTransport = {
  send: (input: SendSessionInput) => Promise<unknown>;
  resume: (input: { sessionId: string }) => Promise<unknown>;
  stop: (input: { sessionId: string } & StopOptions) => Promise<unknown>;
  inbox: InboxTransport;
};

/**
 * Transport port for a session client.
 *
 * Read capabilities (`loadTurns`, `openEvents`) are always required so the
 * client enforces hydration before opening the Session Event Stream. Write
 * capabilities are grouped as an optional bundle; omitting `write` makes the
 * client read-only (for Subagent View).
 */
export type SessionTransport = {
  loadTurns: (input: {
    sessionId: string;
  }) => Promise<AgentTurn<AgentToolSet>[]>;
  openEvents: (input: {
    sessionId: string;
    since?: string;
    abortSignal: AbortSignal;
  }) => Promise<ReadableStream<SessionStreamEvent<AgentToolSet>> | undefined>;
  write?: SessionWriteTransport;
};

export type SessionClientStatus = "submitted" | "streaming" | "ready" | "error";

export type CreateSessionClientOptions = {
  id: string;
  transport: SessionTransport;
  /**
   * Whether to hydrate initial turns via `transport.loadTurns` on `start()`.
   * Defaults to `true`; pass `false` for an unsaved draft session.
   */
  hydrate?: boolean;
  /**
   * Minimum gap in milliseconds between `turns` snapshots published while a
   * response streams, defaulting to `200`. `0` publishes every event.
   */
  throttleMs?: number;
  /** Called for every stream event as it arrives, before folding into turns. */
  emit?: (event: AgentStreamEvent<AgentToolSet>) => void;
};

export type SessionClient = {
  subscribe: (onStoreChange: () => void) => () => void;
  getTurns: () => AgentTurn<AgentToolSet>[];
  getStatus: () => SessionClientStatus;
  getError: () => Error | undefined;
  getInbox: () => InboxItem[];
  isHydrated: () => boolean;
  submit: (options: SubmitOptions) => Promise<void>;
  sendPending: () => Promise<void>;
  cancelPending: (itemId: string) => Promise<void>;
  clearPending: () => Promise<void>;
  addToolApprovalResponse: (
    options: AddToolApprovalResponseOptions
  ) => Promise<void>;
  stop: (options?: StopOptions) => Promise<void>;
  start: () => void;
  destroy: () => void;
};

type ToolApprovalTarget = {
  turnId: string;
  stepId: string;
  toolCallId: string;
};

type SendTurnsOptions = {
  turns: AgentTurn<AgentToolSet>[];
  abortSignal: AbortSignal;
  payload: SubmitPayload;
  approvals?: TextStreamToolApprovalResponseEvent[];
  expectRun: boolean;
  onRejected?: (error: unknown) => void;
};

const RECONNECT_DELAYS_MS = [1000, 2000, 4000];

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const isSessionNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "SESSION_NOT_FOUND";

/**
 * Finds the held tool call an approval answer addresses.
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
 * React-free session client managing initial transcript hydration, Session Event
 * Stream reconnects, turn assembly, inbox queueing, and tool approval replies.
 *
 * Construction performs zero I/O; callers begin network activity via `start()`
 * and tear it down via `destroy()`.
 */
export function createSessionClient({
  id,
  transport,
  hydrate = true,
  throttleMs = 200,
  emit,
}: CreateSessionClientOptions): SessionClient {
  const listeners = new Set<() => void>();

  let currentTurns: AgentTurn<AgentToolSet>[] = [];
  let hydrated = !hydrate;
  let status: SessionClientStatus = "ready";
  let currentError: Error | undefined;
  let hydrationSeq = 0;
  let activeHydration: number | null = null;
  let connection: AbortController | null = null;
  let cursor: SessionCursor | undefined;
  let disposed = true;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let runStreamId: string | undefined;
  let assembler: AgentTurnAssembler<AgentToolSet> | null = null;
  const pendingTurns = new Map<string, AgentUserTurn>();
  const optimisticTurnIds = new Set<string>();
  let inbox: InboxItem[] = [];
  let inboxRevision = 0;
  let enqueueChain: Promise<void> = Promise.resolve();

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const subscribe = (onStoreChange: () => void): (() => void) => {
    listeners.add(onStoreChange);

    return () => {
      listeners.delete(onStoreChange);
    };
  };

  const getTurns = (): AgentTurn<AgentToolSet>[] => currentTurns;
  const getStatus = (): SessionClientStatus => status;
  const getError = (): Error | undefined => currentError;
  const getInbox = (): InboxItem[] => inbox;
  const isHydrated = (): boolean => hydrated;

  const isBusy = (): boolean =>
    status === "submitted" || status === "streaming";

  const commit = (): void => {
    if (assembler) {
      currentTurns = [...assembler.turns];
    }
    notify();
  };

  const publish: () => void =
    throttleMs > 0
      ? throttle((): void => {
          if (runStreamId !== undefined) {
            commit();
          }
        }, throttleMs)
      : commit;

  const bumpInbox = (): void => {
    inboxRevision += 1;
  };

  const refreshInbox = async (): Promise<void> => {
    const { write } = transport;
    if (!write || disposed) {
      return;
    }

    const revision = inboxRevision;

    try {
      const items = await write.inbox.list({ sessionId: id });
      if (disposed || revision !== inboxRevision) {
        return;
      }
      if (status === "submitted" && optimisticTurnIds.size > 0) {
        // Keep the optimistic turn in the transcript only until `run.start` or failure settles it.
        inbox = items.filter((item) => !optimisticTurnIds.has(item.content.id));
      } else {
        if (runStreamId === undefined && optimisticTurnIds.size > 0) {
          // If an early stop left the inbox item in the inbox, remove the optimistic turn so it does not render twice.
          const reconciledIds = new Set<string>();
          for (const item of items) {
            if (optimisticTurnIds.has(item.content.id)) {
              optimisticTurnIds.delete(item.content.id);
              reconciledIds.add(item.content.id);
            }
          }
          if (reconciledIds.size > 0) {
            currentTurns = currentTurns.filter(
              (turn) => !reconciledIds.has(turn.id)
            );
          }
        }
        inbox = items;
      }
      notify();
    } catch {
      // Transient inbox read failure will retry on the next settle or user action.
    }
  };

  const addInboxItem = (item: InboxItem): void => {
    const adopted = currentTurns.some((turn) => turn.id === item.content.id);
    const steered = currentTurns.some(
      (turn) =>
        turn.type === "assistant" &&
        turn.content.some(
          (step) => step.type === "steering" && step.id === item.id
        )
    );
    if (adopted || steered || inbox.some((entry) => entry.id === item.id)) {
      return;
    }

    bumpInbox();
    inbox = [...inbox, item].toSorted((left, right) => left.seq - right.seq);
    notify();
  };

  const removeInboxItem = (itemId: string): void => {
    if (!inbox.some((item) => item.id === itemId)) {
      return;
    }

    bumpInbox();
    inbox = inbox.filter((item) => item.id !== itemId);
    notify();
  };

  const settleRun = (failure: Error | undefined): void => {
    const hadStream = runStreamId !== undefined;
    if (!hadStream && status !== "submitted") {
      return;
    }

    runStreamId = undefined;
    if (hadStream) {
      assembler?.settle(failure ? "error" : "aborted");
      if (assembler) {
        currentTurns = [...assembler.turns];
      }
    }
    if (failure !== undefined && optimisticTurnIds.size > 0) {
      currentTurns = currentTurns.filter(
        (turn) => !optimisticTurnIds.has(turn.id)
      );
      optimisticTurnIds.clear();
    }
    assembler = null;
    currentError = failure;
    status = failure ? "error" : "ready";
    notify();

    void refreshInbox();
  };

  const adoptTurn = (
    turnId: string,
    turn?: AgentUserTurn
  ): AgentUserTurn | undefined => {
    const sent = pendingTurns.get(turnId);
    pendingTurns.delete(turnId);

    const item = inbox.find((entry) => entry.content.id === turnId);
    if (item) {
      removeInboxItem(item.id);
    }

    return sent ?? item?.content ?? turn;
  };

  const startRun = (event: {
    streamId: string;
    turnIds?: readonly string[];
    turns?: readonly AgentUserTurn[];
  }): void => {
    if (event.streamId === runStreamId) {
      return;
    }

    const adopted: AgentUserTurn[] = [];
    for (const turnId of event.turnIds ?? []) {
      optimisticTurnIds.delete(turnId);
      const turn = adoptTurn(
        turnId,
        event.turns?.find((entry) => entry.id === turnId)
      );
      if (
        turn !== undefined &&
        !currentTurns.some((existing) => existing.id === turn.id)
      ) {
        adopted.push(turn);
      }
    }

    assembler = new AgentTurnAssembler<AgentToolSet>({
      turns: [...currentTurns, ...adopted],
    });

    runStreamId = event.streamId;
    currentError = undefined;
    status = "streaming";
    commit();
  };

  const handleStreamEvent = async (
    event: SessionStreamEvent<AgentToolSet>
  ): Promise<void> => {
    if (event.type === "ready") {
      if (cursor !== undefined && cursor.epoch !== event.epoch) {
        settleRun(undefined);
      }

      cursor = { epoch: event.epoch, seq: event.seq };
      return;
    }

    cursor = {
      epoch: cursor?.epoch ?? "",
      seq: Math.max(cursor?.seq ?? 0, event.seq),
    };

    if (event.type === "run.start") {
      startRun(event);
      return;
    }

    if (event.type === "run.end") {
      if (event.streamId === runStreamId) {
        settleRun(
          event.failure === undefined ? undefined : new Error(event.failure)
        );
      }
      return;
    }

    if (event.streamId !== runStreamId || !assembler) {
      return;
    }

    await assembler.push(event.event);
    emit?.(event.event);

    if (event.event.type === "turn.steer") {
      removeInboxItem(event.event.step.id);
    }

    publish();
  };

  const readSessionEvents = async (
    stream: ReadableStream<SessionStreamEvent<AgentToolSet>>,
    controller: AbortController
  ): Promise<Error | undefined> => {
    const reader = stream.getReader();

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done || connection !== controller) {
          return undefined;
        }

        await handleStreamEvent(value);
      }
    } catch (error) {
      return controller.signal.aborted ? undefined : toError(error);
    } finally {
      reader.releaseLock();
    }
  };

  const waitBeforeRetry = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        resolve();
      }, ms);
    });

  const connect = async (attempt = 0): Promise<void> => {
    if (connection || disposed) {
      return;
    }

    const controller = new AbortController();
    connection = controller;

    let failure: Error | undefined;

    try {
      const stream = await transport.openEvents({
        abortSignal: controller.signal,
        sessionId: id,
        ...(cursor === undefined ? {} : { since: formatSessionCursor(cursor) }),
      });

      if (stream && connection === controller) {
        failure = await readSessionEvents(stream, controller);
      }
    } catch (error) {
      failure = controller.signal.aborted ? undefined : toError(error);
    }

    if (connection !== controller) {
      return;
    }

    connection = null;

    if (disposed) {
      return;
    }

    const delay = RECONNECT_DELAYS_MS[attempt];
    if (delay !== undefined) {
      await waitBeforeRetry(delay);

      if (!disposed) {
        await connect(attempt + 1);
      }
      return;
    }

    settleRun(failure);
  };

  const hydrateAndConnect = async (): Promise<void> => {
    hydrationSeq += 1;
    const token = hydrationSeq;
    activeHydration = token;

    try {
      const loaded = await transport.loadTurns({ sessionId: id });

      if (disposed || activeHydration !== token) {
        return;
      }

      activeHydration = null;
      currentTurns = loaded;
      hydrated = true;
      notify();

      void connect();
      void refreshInbox();
    } catch (error) {
      if (disposed || activeHydration !== token) {
        return;
      }

      activeHydration = null;
      currentError = toError(error);
      status = "error";
      hydrated = true;
      notify();
    }
  };

  const destroy = (): void => {
    disposed = true;
    activeHydration = null;
    connection?.abort();
    connection = null;

    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const start = (): void => {
    if (
      !disposed &&
      (activeHydration !== null ||
        connection !== null ||
        retryTimer !== undefined)
    ) {
      return;
    }

    disposed = false;

    if (!hydrated) {
      void hydrateAndConnect();
      return;
    }

    void connect();
    void refreshInbox();
  };

  const sendTurns = async ({
    turns: nextTurns,
    abortSignal,
    payload,
    approvals,
    expectRun,
    onRejected,
  }: SendTurnsOptions): Promise<void> => {
    const { write } = transport;
    if (!write) {
      throw new Error("This session is read-only.");
    }

    const idle = runStreamId === undefined;
    if (idle) {
      currentError = undefined;
      status = "submitted";
      notify();
    }

    try {
      await write.send({
        sessionId: id,
        turns: nextTurns,
        abortSignal,
        payload,
        ...(approvals === undefined ? {} : { approvals }),
      });
    } catch (error) {
      onRejected?.(error);
      if (idle) {
        currentError = abortSignal.aborted ? undefined : toError(error);
        status = abortSignal.aborted ? "ready" : "error";
        notify();
      }
      throw error;
    }

    // Stay in `"submitted"` while expecting `run.start`; return to `"ready"` when
    // a held approval response answered only part of a multi-tool turn.
    if (idle && runStreamId === undefined && !expectRun) {
      status = "ready";
      notify();
    }
  };

  const sendDirect = async (
    turn: AgentUserTurn,
    payload: SubmitPayload
  ): Promise<void> => {
    const optimistic = !currentTurns.some((entry) => entry.id === turn.id);
    if (optimistic) {
      optimisticTurnIds.add(turn.id);
      currentTurns = [...currentTurns, turn];
      if (runStreamId !== undefined) {
        notify();
      }
    }

    try {
      await sendTurns({
        turns: currentTurns,
        abortSignal: new AbortController().signal,
        payload,
        expectRun: true,
        onRejected: () => {
          if (optimistic) {
            optimisticTurnIds.delete(turn.id);
            currentTurns = currentTurns.filter((entry) => entry.id !== turn.id);
            if (runStreamId !== undefined) {
              notify();
            }
          }
        },
      });
    } catch (error) {
      throw toError(error);
    }
  };

  const submit = async ({
    turn,
    mode,
    payload,
  }: SubmitOptions): Promise<void> => {
    const { write } = transport;
    if (!write) {
      throw new Error("This session is read-only.");
    }

    pendingTurns.set(turn.id, turn);

    if (currentTurns.length === 0) {
      try {
        await sendDirect(turn, payload);
      } catch (error) {
        pendingTurns.delete(turn.id);
        throw error;
      }
      return;
    }

    const enqueueTask = enqueueChain.then(async () => {
      const busy = isBusy();
      const effectiveMode: SubmitMode = busy
        ? (mode ?? "followup")
        : "followup";

      let item: InboxItem;
      try {
        const result = await write.inbox.enqueue({
          sessionId: id,
          dedupeKey: nanoid(),
          mode: effectiveMode,
          turn,
          model: payload.model,
          ...(payload.modelEffort === undefined
            ? {}
            : { modelEffort: payload.modelEffort }),
          ...(typeof payload.projectId === "string"
            ? { projectId: payload.projectId }
            : {}),
        });
        ({ item } = result);
      } catch (error) {
        pendingTurns.delete(turn.id);
        if (isSessionNotFound(error)) {
          await sendDirect(turn, payload);
          return;
        }
        throw error;
      }

      addInboxItem(item);
    });

    enqueueChain = enqueueTask.catch(() => {
      // Keep later enqueues running in order even if an earlier one fails.
    });

    await enqueueTask;
  };

  const sendPending = async (): Promise<void> => {
    const { write } = transport;
    if (!write) {
      return;
    }

    await write.resume({ sessionId: id });
    await refreshInbox();
  };

  const forgetPending = (itemId: string): void => {
    const item = inbox.find((entry) => entry.id === itemId);
    if (item) {
      pendingTurns.delete(item.content.id);
    }
  };

  const cancelPending = async (itemId: string): Promise<void> => {
    const { write } = transport;
    if (!write) {
      return;
    }

    await write.inbox.cancel({ sessionId: id, itemId });
    forgetPending(itemId);
    removeInboxItem(itemId);
  };

  const clearPending = async (): Promise<void> => {
    const { write } = transport;
    if (!write) {
      return;
    }

    await write.inbox.clear({ sessionId: id });
    for (const item of inbox) {
      pendingTurns.delete(item.content.id);
    }
    bumpInbox();
    inbox = [];
    notify();
  };

  const addToolApprovalResponse = async ({
    approvalId,
    approved,
    reason,
    data,
    payload,
    abortSignal,
  }: AddToolApprovalResponseOptions): Promise<void> => {
    if (!transport.write) {
      throw new Error("This session is read-only.");
    }

    const target = findToolApprovalTarget(currentTurns, approvalId);

    if (!target) {
      return;
    }

    const answeredAt = Date.now();

    const answer = {
      type: "tool.approval-response",
      id: target.toolCallId,
      approvalId,
      approved,
      ...(reason ? { reason } : {}),
      ...(data ? { data } : {}),
      turnId: target.turnId,
      stepId: target.stepId,
      createdAt: answeredAt,
    } satisfies TextStreamToolApprovalResponseEvent;

    const answerAssembler = new AgentTurnAssembler<AgentToolSet>({
      turns: currentTurns,
    });
    await answerAssembler.push(answer);

    currentTurns = [...answerAssembler.turns];
    notify();

    await sendTurns({
      turns: currentTurns,
      abortSignal: abortSignal ?? new AbortController().signal,
      payload,
      approvals: [answer],
      expectRun: findToolApprovalRequests(currentTurns).length === 0,
    });
  };

  const stop = async (options: StopOptions = {}): Promise<void> => {
    const { write } = transport;
    if (!write) {
      return;
    }

    settleRun(undefined);

    try {
      await write.stop({
        sessionId: id,
        ...(options.keepSubagents === true ? { keepSubagents: true } : {}),
      });
    } catch {
      // Stopping an idle session is a no-op; transient transport errors are already settled locally.
    }
  };

  return {
    subscribe,
    getTurns,
    getStatus,
    getError,
    getInbox,
    isHydrated,
    submit,
    sendPending,
    cancelPending,
    clearPending,
    addToolApprovalResponse,
    stop,
    destroy,
    start,
  };
}
