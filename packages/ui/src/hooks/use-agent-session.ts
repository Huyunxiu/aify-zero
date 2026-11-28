import {
  AgentTurnAssembler,
  formatSessionCursor,
  isAgentToolPart,
} from "@workspace/agent-client";
import type {
  AgentToolSet,
  AgentStreamEvent,
  AgentTurn,
  AgentUserTurn,
  InboxItem,
  JSONObject,
  SessionCursor,
  SessionStreamEvent,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import type { ModelRef } from "@workspace/shared/model";
import { nanoid } from "nanoid";
import * as React from "react";
import throttle from "throttleit";

import { readModelRef } from "../lib/models";

/** 运行中提交消息的投递方式。 */
export type SubmitMode = "steering" | "followup";

/**
 * 服务端收件箱的客户端入口。
 *
 * 入队成功就意味着待办项已经落库，之后即使页面关掉也不会丢；发送失败时它会
 * 留在队列里，等用户手动重试。
 */
export type InboxApi = {
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

export type SubmitOptions = {
  turn: AgentUserTurn;
  /** 运行中才有意义；空闲时按普通发送处理。 */
  mode?: SubmitMode;
  /** 发送所需的模型信息，原样并入请求体。 */
  payload?: Record<string, unknown>;
};

/**
 * What a stop does to the subagents a session started.
 *
 * Absent means the default: the stop takes them with it. `keepSubagents` ends
 * only this run, and the children report when they finish.
 */
export type StopOptions = {
  readonly keepSubagents?: boolean;
};

export type UseAgentSessionOptions = {
  id: string;
  api?: string;
  /**
   * 把一条消息交给服务端。
   *
   * 它只负责投递：这一次运行什么时候开始由服务端决定，页面从会话事件流上
   * 看到 `run.start` 就知道。返回值不用，失败用抛的。
   */
  apiSend?: (
    options: {
      sessionId: string;
      turns: AgentTurn<AgentToolSet>[];
      abortSignal: AbortSignal;
      approvals?: TextStreamToolApprovalResponseEvent[];
    } & Record<string, unknown>
  ) => Promise<unknown>;
  /**
   * 会话的事件流：这个 store 唯一的读者。
   *
   * 一条连接读完这个会话接下来所有的运行，每次运行自成一段（`run.start` 到
   * `run.end`）。页面在挂载时打开它，之后不再为每次发送另开一条。
   */
  apiEvents?: (options: {
    sessionId: string;
    /**
     * 从哪一条之后接着读。断线重连时带上它，服务端就不会把已经看过的事件
     * 再发一遍；第一次连接没有游标。
     */
    since?: string;
    abortSignal: AbortSignal;
  }) => Promise<ReadableStream | undefined>;
  /** 让停下来的队列继续：清掉服务端的暂停，再取一次件。 */
  apiResume?: (options: { sessionId: string }) => Promise<unknown>;
  /**
   * Stops the turn the session is running on the server. Located by
   * `sessionId`, not by a stream id — the client holds only the session's.
   *
   * 和其他回调一样，只在 store 建立时读一次。
   */
  apiStop?: (options: { sessionId: string } & StopOptions) => Promise<unknown>;
  /**
   * Durable pending-message queue. Read when the store is created, like the
   * other API callbacks.
   */
  apiInbox?: InboxApi;
  /**
   * 这个页面能不能发消息。只读的子会话页面既不列队列，也不发送。
   */
  allowSend?: boolean;
  /**
   * Minimum gap, in milliseconds, between the `turns` snapshots published while
   * a response streams, defaulting to `200`. Every publish hands subscribers a
   * new array, and a text delta arrives per token, so without this the
   * transcript re-renders once per token; the intermediate frames are collapsed
   * and only the latest state is painted. `0` publishes every event.
   *
   * 只有回合快照受抑制：`status`、`error` 的变化和 `onEvent` 不受，一次运行
   * 的最后一份快照也总是立刻发出。
   *
   * 和 `api` 一样，只在 store 建立时读，所以新值要等会话 id 变化才生效。
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
  pendingMessages: InboxItem[];
  /**
   * Submits a user turn.
   *
   * A session with no transcript yet sends directly — the server has no row to
   * attach an inbox item to. Every later message is enqueued, so a failed send
   * cannot lose it; the server's runner takes it from there.
   *
   * The promise resolves once the message is accepted (enqueued, or accepted by
   * the server), which is what lets the composer clear only on success.
   */
  submit: (options: SubmitOptions) => Promise<void>;
  /**
   * 让服务端停下来的队列继续。
   *
   * 暂停在服务端的内存里，页面只说一声「继续」；取件、认领、起跑仍然由
   * 服务端的运行器做。
   */
  sendPending: () => Promise<void>;
  cancelPending: (itemId: string) => Promise<void>;
  clearPending: () => Promise<void>;
  sendTurns: (options: SendTurnsOptions) => Promise<void>;
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
   * 停掉这个会话正在跑的那次运行。
   *
   * 屏幕先落定，服务端的那次运行随后停下——它活得比发起它的请求久。会话的
   * 连接留着，下一次运行的 `run.start` 还要送到这里。
   */
  stop: (options?: StopOptions) => Promise<void>;
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
  /** Keep `"submitted"` status after acceptance until `run.start` arrives. */
  expectRun?: boolean;
  /** 服务端收下了这条（消息已落库）时调用。 */
  onAccepted?: () => void;
  /** 流拿到之前失败时调用，参数是原始错误。 */
  onRejected?: (error: unknown) => void;
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
  getInbox: () => InboxItem[];
  submit: (options: SubmitOptions) => Promise<void>;
  sendPending: () => Promise<void>;
  cancelPending: (itemId: string) => Promise<void>;
  clearPending: () => Promise<void>;
  sendTurns: (options: SendTurnsOptions) => Promise<void>;
  addToolApprovalResponse: (
    options: AddToolApprovalResponseOptions
  ) => Promise<void>;
  stop: (options?: StopOptions) => Promise<void>;
  /** 页面卸载：停掉连接与重连。 */
  destroy: () => void;
  /** 页面挂载：开始读这个会话；`destroy` 之后也能再开一次。 */
  start: () => void;
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
 * `AgentTurnAssembler` mutates the turns array in place and never changes its
 * identity, so each snapshot published here is a shallow copy taken right after
 * a mutation — the identity changes exactly when the content does, which is
 * what `useSyncExternalStore` requires of a snapshot.
 */
export function createAgentSessionStore({
  id,
  api,
  apiSend,
  apiEvents,
  apiResume,
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
  /** 这个 store 与服务的唯一连接：会话事件流。 */
  let connection: AbortController | null = null;
  /** 读到哪里了；重连时带上去，服务端从下一条接着发。 */
  let cursor: SessionCursor | undefined;
  /** 页面已经走了：不再重连。 */
  let disposed = false;
  /** 等下一次重连的计时器；卸载时要清掉。 */
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 正在读的那一次运行；同时说明屏幕上有一条还在流。 */
  let runStreamId: string | undefined;
  /** 这一次运行的装配器；每次运行换一个。 */
  let assembler: AgentTurnAssembler<AgentToolSet> | null = null;
  /** 已经发出、还没有起跑的 user 回合，按回合 id 存。 */
  const pendingTurns = new Map<string, AgentUserTurn>();
  /** User turns appended optimistically before `run.start` confirms them. */
  const optimisticTurnIds = new Set<string>();
  let inbox: InboxItem[] = [];
  let inboxRevision = 0;
  /** Serializes inbox enqueue requests so rapid back-to-back submits land in send order. */
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
  const getStatus = (): AgentSessionStatus => status;
  const getError = (): Error | undefined => currentError;
  const getInbox = (): InboxItem[] => inbox;

  const isBusy = (): boolean =>
    status === "submitted" || status === "streaming";

  /**
   * 把装配器此刻的内容发出去。
   *
   * `commit` 读的是 `assembler.turns` 而不是别人递进来的快照，所以被合并掉的
   * 那次调用发布的是最新状态，丢的只是中间帧。
   */
  const commit = (): void => {
    if (assembler) {
      currentTurns = [...assembler.turns];
    }
    notify();
  };

  /**
   * `commit` on a leash: at most one snapshot per window while a response
   * streams, so per-token deltas stop forcing a render each.
   *
   * 抑制窗口是 store 级的，但判断「还该不该画」用的是 `runStreamId`：收尾之后
   * 遗留的那次调用到这里时已经没有人可画了。
   */
  const publish: () => void =
    throttleMs > 0
      ? throttle((): void => {
          if (runStreamId !== undefined) {
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
      if (status === "submitted" && optimisticTurnIds.size > 0) {
        // Keep the optimistic turn in the transcript only until `run.start` or failure settles it.
        inbox = messages.filter(
          (item) => !optimisticTurnIds.has(item.content.id)
        );
      } else {
        if (runStreamId === undefined && optimisticTurnIds.size > 0) {
          // If an early stop left the message in the inbox, remove the optimistic turn so it does not render twice.
          const reconciledIds = new Set<string>();
          for (const item of messages) {
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
        inbox = messages;
      }
      notify();
    } catch {
      // 下一次 settle 或用户操作会再试。
    }
  };

  const addInboxItem = (item: InboxItem): void => {
    // 入队响应回来之前，它可能已经被领走：以 user 回合的身份进了记录（运行已经
    // 开始），或者被引导进当前回合——两种都不该再出现在队列里。
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

  /**
   * 这一条运行落定。
   *
   * 只有正在读的那一次能写状态：迟到的 `run.end`（本地已经停过）不改屏幕上
   * 已经落定的内容。
   *
   * 落定之后立刻对齐队列：待办项可能已经被服务端领走，队列该少一条了。
   */
  const settleRun = (failure: Error | undefined): void => {
    const hadStream = runStreamId !== undefined;
    if (!hadStream && status !== "submitted") {
      return;
    }

    runStreamId = undefined;
    if (hadStream) {
      // Settle any in-progress parts on the active assembler before reading the final snapshot.
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

  /**
   * 认领这条 user 回合。
   *
   * 消息发出时先记在 `pendingTurns` 里：它要等到运行真的开始才算进入会话记录，
   * 而「开始」这件事是服务端说的——`run.start` 带来它领走的那几条回合的 id。
   * 队列里的同一条从队列里撤下，它已经以回合的身份出现在记录里了。
   *
   * 有些回合不是这一页发的（例如后台任务的完成通知）：它既不在 `pendingTurns`，
   * 也来不及在收件箱里被看见，所以 `run.start` 把内容一起带来。
   */
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

  /** 一次运行开始：把它的 user 回合接进记录，然后等它的事件。 */
  const startRun = (event: {
    streamId: string;
    turnIds?: readonly string[];
    turns?: readonly AgentUserTurn[];
  }): void => {
    if (event.streamId === runStreamId) {
      // 已经在读这一次运行：重放的内容不能变成第二份。
      return;
    }

    // 一次运行可以领走多条待办项。已经在记录里的那几条认领会返回 undefined，
    // 装配器仍然从 `currentTurns` 拿到它们；这一页没发过、也没见过的回合（完成
    // 通知）靠事件带来的内容接进记录。
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

    // 每次运行一个装配器：它从这一条开始改写，上一条已经落定的内容不再变。
    assembler = new AgentTurnAssembler<AgentToolSet>({
      turns: [...currentTurns, ...adopted],
    });

    runStreamId = event.streamId;
    currentError = undefined;
    status = "streaming";
    commit();
  };

  /**
   * 会话事件流上的一条事件。
   *
   * `run.event` 之前一定先有 `run.start`：服务端按这个顺序发，所以装配器总是
   * 先有它要改写的回合。不属于正在读的那次运行的事件在这里被丢弃——它们要么
   * 已经落定，要么已经写进会话记录。
   */
  const handleStreamEvent = async (
    event: SessionStreamEvent<AgentToolSet>
  ): Promise<void> => {
    if (event.type === "ready") {
      // 通道换了实例说明手上的游标作废：这次运行的重放接不上，按丢失收尾，
      // 让页面重新挂载时重读会话记录。
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

    // 剩下的是 `run.event`。不属于正在读的那次运行的事件在这里丢掉：它们要么
    // 已经落定，要么已经写进会话记录。
    if (event.streamId !== runStreamId || !assembler) {
      return;
    }

    await assembler.push(event.event);
    emit(event.event);

    // 引导消息已经落进当前 assistant turn：队列里的同 id 项可以撤下。
    if (event.event.type === "turn.steer") {
      removeInboxItem(event.event.step.id);
    }

    publish();
  };

  /**
   * 读到会话事件流结束为止，返回结束的原因（正常关闭时没有）。
   *
   * 关闭一条连接不等于结束一次运行：运行之间的空档里这条流是安静的，而
   * `run.end` 才是运行结束的那一条。所以这里只把原因交回去，落定不落定由
   * `connect` 决定——它可能带着游标再接一次。
   */
  const readSessionEvents = async (
    stream: ReadableStream,
    controller: AbortController
  ): Promise<Error | undefined> => {
    const reader = stream.getReader();

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done || connection !== controller) {
          return undefined;
        }

        await handleStreamEvent(value as SessionStreamEvent<AgentToolSet>);
      }
    } catch (error) {
      return controller.signal.aborted ? undefined : toError(error);
    } finally {
      reader.releaseLock();
    }
  };

  /**
   * 打开这个会话的事件流：这个 store 唯一的读者。
   *
   * 页面上的一条连接一直读到会话不再有人看为止。运行开始、结束都不会关掉它，
   * 所以排队中的消息被服务端领走时，页面已经在读了——不需要谁去追那条新出现
   * 的流。
   */
  /**
   * 重连的等待时间。
   *
   * 真实的断线（代理超时、合盖休眠）会持续几秒，立即重试必然撞在断口上。
   * 几次之后放弃：再久就是「服务端不在」，该由人刷新。
   */
  const RECONNECT_DELAYS_MS = [1000, 2000, 4000];

  /** 等一会儿再重连；页面走了就让这个 Promise 永远不兑现。 */
  const waitBeforeRetry = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        resolve();
      }, ms);
    });

  const connect = async (attempt = 0): Promise<void> => {
    if (!apiEvents || connection || disposed) {
      return;
    }

    const controller = new AbortController();
    connection = controller;

    let failure: Error | undefined;

    try {
      const stream = await apiEvents({
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
      // 被取代了（换了 store，或者页面卸了），没有要收的尾。
      return;
    }

    connection = null;

    if (disposed) {
      return;
    }

    // 断线重连。运行还挂在装配器上，带游标接上就不会重画；通道换了实例时
    // `ready` 会把这次运行按丢失收尾。等几次还不行就落定，不在这里空转。
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

  /** 页面走了：停掉连接和还在等的那次重连。 */
  const destroy = (): void => {
    disposed = true;
    connection?.abort();
    connection = null;

    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  /**
   * 页面回来了：接着读这个会话。
   *
   * 和 `destroy` 成对。页面卸载又挂载时（开发期的 StrictMode 每次挂载都会先
   * 卸一次），连接必须能再开一次；只销毁不再开，发送之后就再也收不到事件，
   * 页面上的消息不会实时出现。
   */
  const start = (): void => {
    disposed = false;
    void connect();
    void refreshInbox();
  };

  /**
   * 把一条消息交给服务端。
   *
   * 这里不等运行开始：消息落库之后，这一次运行什么时候跑由运行器决定，页面
   * 从事件流的 `run.start` 上看到它。等一条流回来只会让「谁在跑」这个判断
   * 挤回到发送路径上。
   */
  const sendTurns = async ({
    turns: nextTurns,
    abortSignal,
    payload,
    inboxId,
    expectRun = false,
    onAccepted,
    onRejected,
  }: SendTurnsOptions): Promise<void> => {
    const body = {
      sessionId: id,
      turns: nextTurns,
      ...payload,
      ...(inboxId ? { inboxId } : {}),
    };

    // 有运行在跑的时候不改状态：屏幕上的那条还在流，它才是当前状态。
    const idle = runStreamId === undefined;
    if (idle) {
      currentError = undefined;
      status = "submitted";
      notify();
    }

    try {
      if (apiSend) {
        await apiSend({ ...body, abortSignal });
      } else if (api) {
        const response = await fetch(api, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: abortSignal,
        });

        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }
      } else {
        throw new Error("sendTurns needs an API to send with.");
      }
    } catch (error) {
      onRejected?.(error);
      if (idle) {
        currentError = abortSignal.aborted ? undefined : toError(error);
        status = abortSignal.aborted ? "ready" : "error";
        notify();
      }
      throw error;
    }

    onAccepted?.();

    // When expecting a run on the event stream, stay in `"submitted"` until `run.start` arrives.
    if (idle && runStreamId === undefined && !expectRun) {
      status = "ready";
      notify();
    }
  };

  /**
   * Starts the first turn directly before a session row exists for the inbox.
   *
   * Appends the turn optimistically so the transcript updates immediately, and
   * clears it if the request or run startup fails.
   */
  const sendDirect = async (
    turn: AgentUserTurn,
    payload: Record<string, unknown> | undefined
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
        expectRun: apiEvents !== undefined,
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
    if (!allowSend) {
      throw new Error("This session is read-only.");
    }

    const model = readModelRef(payload?.model);
    if (!model) {
      throw new Error("submit requires a model.");
    }

    // 先记下这条回合：它出现在记录里的时刻由服务端的 `run.start` 决定，而那时
    // 这条消息可能已经从队列里消失了。
    pendingTurns.set(turn.id, turn);

    // 新会话还没有行可以挂 Inbox，直接走原来的发送路径。
    if (!apiInbox || currentTurns.length === 0) {
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
        const result = await apiInbox.enqueue({
          sessionId: id,
          dedupeKey: nanoid(),
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
        ({ item } = result);
      } catch (error) {
        pendingTurns.delete(turn.id);
        // Transcript exists locally, but the server row is gone: fall back to direct send so the server rebuilds it.
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
    if (!apiResume) {
      return;
    }

    // 暂停在服务端的内存里：这里只说一声「继续」，由它接着取件。
    await apiResume({ sessionId: id });
    await refreshInbox();
  };

  /** 队列里这一条被取消了，它的 user 回合也不会再开始。 */
  const forgetPending = (itemId: string): void => {
    const item = inbox.find((entry) => entry.id === itemId);
    if (item) {
      pendingTurns.delete(item.content.id);
    }
  };

  const cancelPending = async (itemId: string): Promise<void> => {
    if (!apiInbox) {
      return;
    }

    await apiInbox.cancel({ sessionId: id, itemId });
    forgetPending(itemId);
    removeInboxItem(itemId);
  };

  const clearPending = async (): Promise<void> => {
    if (!apiInbox) {
      return;
    }

    await apiInbox.clear({ sessionId: id });
    for (const item of inbox) {
      pendingTurns.delete(item.content.id);
    }
    bumpInbox();
    inbox = [];
    notify();
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

    // The answer is applied to the transcript through the assembler, with the
    // very event the stream would carry. That is what keeps the local answer
    // and a streamed one the same rewrite of the same fields — the part moves
    // to `approval-responded` and nothing else about it moves, because the call
    // has not run and only the stream can say that it did.
    const answerAssembler = new AgentTurnAssembler<AgentToolSet>({
      turns: currentTurns,
    });
    await answerAssembler.push(answer);

    // The rewrite was in place, so the snapshot has to take a new identity for
    // the listeners to see it — the rule every publish here keeps, and the one
    // `useSyncExternalStore` demands of a snapshot.
    currentTurns = [...answerAssembler.turns];
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
   * 停掉这一条运行。
   *
   * 屏幕先落定，服务端的那次运行随后停下——它按设计活得比发起它的请求久，
   * 所以这里不能等它。
   *
   * 连接留着：停下一次运行不等于这个会话不再有人看，下一次运行的
   * `run.start` 还要送到这里。
   */
  const stop = async (options: StopOptions = {}): Promise<void> => {
    if (!apiStop) {
      return;
    }

    settleRun(undefined);

    try {
      await apiStop({
        sessionId: id,
        ...(options.keepSubagents === true ? { keepSubagents: true } : {}),
      });
    } catch {
      // 停一条没在跑的运行是空操作，不是失败；传输失败也已经由本地落定覆盖。
    }
  };

  // 建出来就开始读这个会话：正在跑的运行会被重放，之后的每一次运行都接着送
  // 到同一条连接上。页面卸载又挂载时由 `start` 再开一次，见它的注释。
  void connect();
  // 顺带恢复服务端的队列；不自动发送，交给服务端按它自己的节奏取件。
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
    addToolApprovalResponse,
    stop,
    destroy,
    start,
  };
}

export function useAgentSession({
  id,
  api,
  apiSend,
  apiEvents,
  apiResume,
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
      apiSend,
      apiEvents,
      apiResume,
      apiStop,
      apiInbox,
      allowSend,
      throttleMs,
      turns,
      emit,
    });
  }

  const store = storeRef.current;

  // 连接的生死跟着页面走，而不是跟着某一次渲染走：挂载时开始读，卸载时停掉。
  // 两者必须成对——开发期的 StrictMode 每次挂载都先卸一次，只销毁不再开，
  // 页面就再也读不到事件，发送之后也没有实时消息。
  React.useEffect(() => {
    store.start();

    return () => store.destroy();
  }, [store]);

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
    addToolApprovalResponse: store.addToolApprovalResponse,
    stop: store.stop,
    error,
    status,
  };
}
