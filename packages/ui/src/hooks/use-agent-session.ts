import type { AgentToolSet } from "@workspace/agent";
import {
  AgentTurnBuilder,
  findToolApprovalRequests,
  isAgentToolPart,
} from "@workspace/agent-client";
import type {
  AgentStreamEvent,
  AgentTurn,
  AgentUserTurn,
  InboxMessage,
  JSONObject,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import { parseJsonEventStream } from "ai";
import { nanoid } from "nanoid";
import * as React from "react";
import throttle from "throttleit";

/** 运行中提交消息的投递方式。 */
export type SubmitMode = "steering" | "followup";

/**
 * 服务端 Inbox 的客户端入口。
 *
 * 入队成功就意味着消息已经落库，之后即使页面关掉也不会丢；发送失败时它会
 * 留在队列里，等用户手动重试。
 */
export type InboxApi = {
  list: (input: { sessionId: string }) => Promise<InboxMessage[]>;
  enqueue: (input: {
    sessionId: string;
    requestId: string;
    mode: SubmitMode;
    turn: AgentUserTurn;
    model: string;
    modelEffort?: string;
    projectId?: string;
  }) => Promise<{ message: InboxMessage }>;
  cancel: (input: { sessionId: string; messageId: string }) => Promise<unknown>;
  clear: (input: { sessionId: string }) => Promise<unknown>;
};

export type SubmitOptions = {
  turn: AgentUserTurn;
  /** 运行中才有意义；空闲时按普通发送处理。 */
  mode?: SubmitMode;
  /** 发送所需的模型信息，原样并入请求体。 */
  payload?: Record<string, unknown>;
};

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
   * Durable pending-message queue. Read when the store is created, like the
   * other API callbacks.
   */
  apiInbox?: InboxApi;
  /**
   * Whether this page may send at all. A read-only subagent page lists nothing
   * and drains nothing.
   */
  allowSend?: boolean;
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
  /** 服务端返回的待发送消息，按 FIFO 排列。 */
  pendingMessages: InboxMessage[];
  /**
   * Submits a user turn.
   *
   * A session with no transcript yet sends directly — the server has no row to
   * attach an inbox item to. Every later message is enqueued first, so a
   * failed send cannot lose it, then drained.
   *
   * The promise resolves once the message is accepted (enqueued, or the first
   * turn's stream has started), which is what lets the composer clear only on
   * success.
   */
  submit: (options: SubmitOptions) => Promise<void>;
  /** Clears the paused flag and sends the next pending message. */
  sendPending: () => Promise<void>;
  cancelPending: (messageId: string) => Promise<void>;
  clearPending: () => Promise<void>;
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
  /** 这条 user turn 来自 Inbox 的哪一行；服务端在同一事务里认领。 */
  inboxId?: string;
  /** 请求已被服务端接受（流已拿到）时调用。 */
  onAccepted?: () => void;
  /** 流拿到之前失败时调用，参数是原始错误。 */
  onRejected?: (error: unknown) => void;
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
   * Opaque, JSON-serializable data to keep with the answer.
   *
   * It is stored on the approval and travels back with the resumed turn, so a
   * caller can attach what it needs to a decision without changing the
   * protocol. The agent never reads it, and it is not sent to the model.
   */
  data?: JSONObject;
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
  getInbox: () => InboxMessage[];
  submit: (options: SubmitOptions) => Promise<void>;
  sendPending: () => Promise<void>;
  cancelPending: (messageId: string) => Promise<void>;
  clearPending: () => Promise<void>;
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

/** oRPC 错误带着 `code`；队列发送失败时用它区分“已被领走”和真正的失败。 */
const isInboxMessageNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "INBOX_MESSAGE_NOT_FOUND";

const isSessionNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "SESSION_NOT_FOUND";

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
  apiInbox,
  allowSend = true,
  throttleMs = 200,
  turns,
  emit,
}: AgentSessionStoreOptions): AgentSessionStore {
  const listeners = new Set<() => void>();

  let currentTurns = turns;
  let status: AgentSessionStatus = "ready";
  let currentError: Error | undefined;
  let active: AbortController | null = null;
  let inbox: InboxMessage[] = [];
  let inboxRevision = 0;
  let sendingId: string | undefined;
  let drainPaused = false;
  let draining = false;

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
  const getInbox = (): InboxMessage[] => inbox;

  const isBusy = (): boolean =>
    status === "submitted" || status === "streaming";

  const hasPendingApproval = (): boolean =>
    findToolApprovalRequests(currentTurns).length > 0;

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

  /** 队列发生了本地增删；正在路上的列表响应不能再覆盖它。 */
  const bumpInbox = (): void => {
    inboxRevision += 1;
  };

  /**
   * 从服务端重新读取待发送消息。
   *
   * 本地增删会让这次请求作废：列表响应可能比本地状态旧，下一次刷新再对齐。
   * 读取失败不冒泡——队列是辅助信息，不该把 transcript 拖进错误态。
   */
  const refreshInbox = async (): Promise<void> => {
    if (!apiInbox) {
      return;
    }

    const revision = inboxRevision;

    try {
      const messages = await apiInbox.list({ sessionId: id });
      if (revision !== inboxRevision) {
        return;
      }
      inbox = messages;
      notify();
    } catch {
      // 下一次 settle 或用户操作会再试。
    }
  };

  const addInboxMessage = (message: InboxMessage): void => {
    // 入队响应回来之前，流可能已经用 turn.steer 把它领走并删了行。
    const claimed = currentTurns.some(
      (turn) =>
        turn.type === "assistant" &&
        turn.content.some(
          (step) => step.type === "steering" && step.id === message.id
        )
    );
    if (claimed || inbox.some((item) => item.id === message.id)) {
      return;
    }

    bumpInbox();
    inbox = [...inbox, message].toSorted((left, right) => left.seq - right.seq);
    notify();
  };

  const removeInboxMessage = (messageId: string): void => {
    if (!inbox.some((item) => item.id === messageId)) {
      return;
    }

    bumpInbox();
    inbox = inbox.filter((item) => item.id !== messageId);
    if (sendingId === messageId) {
      sendingId = undefined;
    }
    notify();
  };

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

    // 回合结束后队列可能已经变化：先对齐服务端，再尝试发送下一条。错误态
    // 不自动重试，避免一条坏消息在失败后立刻再次触发同一个错误。
    void refreshInbox().then(() => {
      if (status === "ready") {
        void drain();
      }
    });
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

        // 引导消息已经落进当前 assistant turn：队列里的同 id 项可以撤下。
        if (event.type === "turn.steer") {
          removeInboxMessage(event.step.id);
        }

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
    inboxId,
    onAccepted,
    onRejected,
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
      const body = {
        sessionId: id,
        turns: nextTurns,
        ...payload,
        ...(inboxId ? { inboxId } : {}),
      };
      let stream: ReadableStream | undefined = undefined;
      if (apiStream) {
        stream = await apiStream({ ...body, abortSignal: controller.signal });
        // The stream has been handed over, so the turn is under way — the same
        // transition the `api` branch makes when its response arrives.
        if (stream && active === controller) {
          setStatus("streaming");
        }
        if (stream) {
          onAccepted?.();
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
        onAccepted?.();

        stream = parseJsonEventStream<AgentStreamEvent<AgentToolSet>>({
          stream: response.body,
          // `schema` is required by the signature but optional at runtime, where
          // a null schema yields the unvalidated JSON as-is.
          schema: undefined as any,
        });
      }

      // 注意：这里会有工具还未审批完导致 stream 没有的情况
      if (!stream) {
        onRejected?.(new Error("The chat did not start a turn."));
        return;
      }

      await readInto({ stream, builder, controller, commit, publish });
    } catch (error) {
      // Nothing is being read — the request was refused, or the transport died
      // before a stream existed — so the ending is settled here instead.
      onRejected?.(error);
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
   * 直接开始一个回合，并等到服务端接受为止。
   *
   * 首条消息还没有 session 行可以挂 Inbox，只能走这条路；`onAccepted` 在流
   * 拿到后才 resolve，编辑器因此只在真正开始后才清空。
   */
  const sendDirect = (
    turn: AgentUserTurn,
    payload: Record<string, unknown> | undefined
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      void sendTurns({
        turns: [...currentTurns, turn],
        abortSignal: new AbortController().signal,
        payload,
        onAccepted: resolve,
        onRejected: reject,
      });
    });

  /**
   * 发送队列里的下一条。
   *
   * 一次只发一条；成功领取后从队列移除，等这次回合 settle 再发下一条。
   * 失败时保留消息并暂停自动发送，避免同一条坏消息反复重试。
   */
  const drain = async (): Promise<void> => {
    if (!apiInbox || !allowSend || draining || drainPaused) {
      return;
    }
    if (isBusy() || hasPendingApproval()) {
      return;
    }

    const [next] = inbox;
    if (!next) {
      return;
    }

    draining = true;
    sendingId = next.id;
    notify();

    try {
      await new Promise<void>((resolve, reject) => {
        void sendTurns({
          turns: [...currentTurns, next.content],
          payload: { ...next.payload },
          abortSignal: new AbortController().signal,
          inboxId: next.id,
          onAccepted: resolve,
          onRejected: reject,
        });
      });
      removeInboxMessage(next.id);
    } catch (error) {
      if (isInboxMessageNotFound(error)) {
        removeInboxMessage(next.id);
      } else {
        drainPaused = true;
      }
    } finally {
      draining = false;
      if (sendingId === next.id) {
        sendingId = undefined;
      }
      notify();
    }
  };

  const submit = async ({
    turn,
    mode,
    payload,
  }: SubmitOptions): Promise<void> => {
    if (!allowSend) {
      throw new Error("This session is read-only.");
    }

    const model =
      typeof payload?.model === "string" ? payload.model : undefined;
    if (!model) {
      throw new Error("submit requires a model.");
    }

    // 新会话还没有行可以挂 Inbox，直接走原来的发送路径。
    if (!apiInbox || currentTurns.length === 0) {
      await sendDirect(turn, payload);
      return;
    }

    // 用户明确发了一条新消息：之前因停止/失败暂停的队列继续。
    drainPaused = false;

    const busy = isBusy();
    const effectiveMode: SubmitMode = busy ? (mode ?? "followup") : "followup";

    let message: InboxMessage;
    try {
      const result = await apiInbox.enqueue({
        sessionId: id,
        requestId: nanoid(),
        mode: effectiveMode,
        turn,
        model,
        modelEffort:
          typeof payload?.modelEffort === "string"
            ? payload.modelEffort
            : undefined,
        projectId:
          typeof payload?.projectId === "string"
            ? payload.projectId
            : undefined,
      });
      ({ message } = result);
    } catch (error) {
      // 本地有 transcript 但服务端行已经不在：退回直接发送，让服务端重建。
      if (isSessionNotFound(error)) {
        await sendDirect(turn, payload);
        return;
      }
      throw error;
    }

    addInboxMessage(message);
    void drain();
  };

  const sendPending = async (): Promise<void> => {
    drainPaused = false;
    await drain();
  };

  const cancelPending = async (messageId: string): Promise<void> => {
    if (!apiInbox) {
      return;
    }

    await apiInbox.cancel({ sessionId: id, messageId });
    removeInboxMessage(messageId);
  };

  const clearPending = async (): Promise<void> => {
    if (!apiInbox) {
      return;
    }

    await apiInbox.clear({ sessionId: id });
    bumpInbox();
    inbox = [];
    notify();
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
    data,
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
      ...(data ? { data } : {}),
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

    // 用户按了停止：回合结束后的 settle 不能立刻把队列里的消息再发出去。
    // “立即发送”或下一次显式提交会清除这个暂停标记。
    drainPaused = true;

    // The local read has to stop too: the server closes its stream, but a
    // reader parked in `read()` must be woken, or the turn never settles.
    active?.abort();

    try {
      await apiStop({ sessionId: id });
    } catch {
      // Stopping a turn that is not running is a no-op, not a failure, and a
      // transport failure here is already covered by the aborted transcript.
    }
  };

  // 页面挂载时恢复服务端队列；不自动发送，等下一次 settle 或用户显式操作。
  void refreshInbox();

  return {
    subscribe,
    getTurns,
    getStatus,
    getError,
    getInbox,
    submit,
    sendPending,
    cancelPending,
    clearPending,
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
  apiInbox,
  allowSend,
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
      apiInbox,
      allowSend,
      throttleMs,
      turns,
      emit,
    });
  }

  const store = storeRef.current;

  // Four subscriptions over a single listener set, mirroring `useChat`.
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
  const pendingMessages = React.useSyncExternalStore(
    store.subscribe,
    store.getInbox,
    store.getInbox
  );

  return {
    turns: currentTurns,
    pendingMessages,
    submit: store.submit,
    sendPending: store.sendPending,
    cancelPending: store.cancelPending,
    clearPending: store.clearPending,
    sendTurns: store.sendTurns,
    resume: store.resume,
    addToolApprovalResponse: store.addToolApprovalResponse,
    stop: store.stop,
    error,
    status,
  };
}
