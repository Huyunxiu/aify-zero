import { DevToolsTelemetry } from "@ai-sdk/devtools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import {
  findToolPartByToolCallId,
  findTurnWithoutToolResult,
} from "@workspace/agent-client";
import type {
  AgentCompactionTurn,
  AgentRuntimeContext,
  AgentStep,
  AgentStreamEvent,
  AgentTurn,
  AgentTurnStatus,
  CompactionRecord,
} from "@workspace/agent-client";
import type { StepInsertModel } from "@workspace/db";
import { ModelEffort } from "@workspace/shared/constants";
import { getErrorMessage } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";
import {
  APICallError,
  generateText,
  isStepCount,
  registerTelemetry,
  streamText,
} from "ai";
import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  StepResultPerformance,
  TextStreamPart,
  Tool,
  ToolContent,
  ToolSet,
} from "ai";
import { collectToolApprovals } from "ai/internal";

import type { AgentContext } from "./agent-context";
import type { AgentSession } from "./agent-session";
import { CompactionError, compactHistory } from "./compaction/compact";
import { estimateMessagesTokens, estimateTokens } from "./compaction/estimate";
import { createCompactionStep } from "./compaction/marker";
import { isContextOverflowError } from "./compaction/overflow";
import {
  resolvePolicy as resolveCompactionPolicy,
  shouldCompact,
} from "./compaction/policy";
import { pruneOlderToolResults } from "./compaction/prune";
import {
  findEndPlacement,
  findPreTurnPlacement,
  measureContext,
  planManualCompaction,
} from "./compaction/select";
import { createSummarizer } from "./compaction/summarizer";
import type { ResolvedCompactionPolicy, SummarizeFn } from "./compaction/types";
import { ExtensionManager } from "./extensions/manager";
import type { Extension } from "./extensions/types";
import { HooksManager } from "./hooks-manager";
import type { HookContext } from "./hooks-manager";
import type { AgentStore, SessionEndStatus, TurnRecord } from "./storage";
import { journaledStepTarget } from "./storage/step-journal";
import { executeToolCalls, stripToolExecution } from "./tools/execution";
import type { AgentToolSet } from "./types";
import {
  generateEventId,
  generateStepId,
  generateTurnId,
} from "./utils/id-util";
import { toAgentEvent } from "./utils/to-agent-stream-event";

registerTelemetry(DevToolsTelemetry());

const MAX_COMPACTIONS_PER_TURN = 3;

const ZERO_USAGE: LanguageModelUsage = {
  inputTokens: 0,
  inputTokenDetails: {
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 0,
  outputTokenDetails: {
    textTokens: 0,
    reasoningTokens: 0,
  },
  totalTokens: 0,
};

export const TITLE_PROMPT = `Generate a very short session title (2-5 words max) based on the user's message.
Rules:
- Maximum 30 characters
- No quotes, colons, hashtags, or markdown
- Just the topic/intent, not a full sentence
- If the message is a greeting like "hi" or "hello", respond with just "New conversation"
- Be concise: "Weather in NYC" not "User asking about the weather in New York City"`;

// Maps effort levels to the AI SDK's reasoning levels.
const MODEL_EFFORT_TO_REASONING = {
  [ModelEffort.Default]: "provider-default",
  [ModelEffort.Off]: "none",
  [ModelEffort.Low]: "low",
  [ModelEffort.Medium]: "medium",
  [ModelEffort.High]: "high",
  [ModelEffort.Ultra]: "xhigh",
} as const;

// A session row borrows the ending the turn already recorded — `aborted` is the
// turn's word for a stop, `canceled` is the session's. `streaming` is listed
// only so this stays exhaustive over `AgentTurnStatus`; a turn is never read
// here before its finish.
//
// The session's `done` is not the turn's `done` flattened out: it also says the
// user has not looked yet, which is what the sidebar draws. Reading the session
// is what clears it back to `idle`.
const TURN_END_TO_SESSION_STATUS = {
  done: "done",
  wait_review: "wait_review",
  aborted: "canceled",
  error: "error",
  streaming: "error",
} as const satisfies Record<AgentTurnStatus["status"], SessionEndStatus>;

export type AgentOptions = {
  name: string;
  sessionId: string;
  session: AgentSession;
  tools?: ToolSet;
  store: AgentStore;
  systemPrompt?: string;
  context: AgentContext;
  hooks?: HooksManager;
  extensionApi?: HookContext;
  apiKey: string;
  apiUrl: string;
  providerId: string;
  modelId: string;
  modelEffort?: ModelEffort;
  /**
   * 这个 agent 所属的外部 abort scope，由派生它的父传进来。父停时它跟着停；和它
   * 自己的 `abort()` 是并集而不是替代，所以子 agent 仍然能被单独停掉。
   */
  abortSignal?: AbortSignal;
};

/**
 * What a stream is asked to run.
 *
 * A turn is the ordinary case: a user turn is in `turns` and the model drives it
 * to an ending. A compaction is the same stream machinery applied to the manual
 * `/compact` path: there is no model turn to run, the agent folds the history
 * itself and writes the marker, and the stream reports it like any other turn.
 * The union is what keeps both behind one entry point — a caller sends the
 * signal, the agent decides what that means.
 */
export type AgentStreamSignal =
  | { readonly type: "turn" }
  | { readonly type: "compaction"; readonly trigger: "manual" };

export type AgentStreamOptions = {
  modelId: string;
  turns: AgentTurn<AgentToolSet>[];
  /**
   * 这次运行的 id；就是会话行上的 `activeStreamId`。
   *
   * step 行把它记进 `step.stream_id`。读取时用它区分“当前运行刚写下的
   * step”和上一次运行留下的 step，避免页面中途加载后又被流重放一遍。
   */
  streamId: string;
  /** What this stream runs; see {@link AgentStreamSignal}. */
  signal: AgentStreamSignal;
  /**
   * How the run ended, so the caller can settle the session it belongs to. The
   * outcome is only known here, once the run has finished.
   */
  onFinish: (status: SessionEndStatus) => Promise<void>;
};

/** 手工压缩被要求压缩一段没有可压缩内容的历史。 */
export class NothingToCompactError extends Error {
  override readonly name = "NothingToCompactError";
}

type AgentTurnInput = {
  readonly title?: string;
  readonly turnType: AgentTurn<AgentToolSet>["type"];
  readonly turnId: string;
  readonly parentId?: string;
};

type AgentStepInput = AgentTurnInput & {
  readonly stepId: string;
  readonly stepType: AgentStep<AgentToolSet>["type"];
};

/** What one completed step of the model loop reported back. */
export type AgentStepResult = {
  /** The step's history, including its own assistant and tool messages. */
  readonly messages: ModelMessage[];
  /** This step's usage alone; {@link Agent.#runTurn} totals it across steps. */
  readonly usage: LanguageModelUsage;
  readonly finishReason: FinishReason;
  readonly rawFinishReason: string | undefined;
  /**
   * Whether every client tool call this step issued came back with a result —
   * the loop's continuation rule.
   */
  readonly toolCallsResolved: boolean;
  /**
   * Whether the step's calls were held for the user to approve. The turn ends
   * on this rather than continuing: there is nothing for the model to read
   * until the user answers, and the answers arrive on the next stream.
   */
  readonly awaitingApproval: boolean;
};

/** What one call of {@link Agent.#runStep} reported back to the turn loop. */
type StepOutcome =
  | { readonly ok: true; readonly result: AgentStepResult }
  /** The turn was aborted: nothing failed, the caller stopped it. */
  | { readonly ok: false; readonly reason: "aborted" }
  /** The model call failed, or the model ended the step with an error. */
  | { readonly ok: false; readonly reason: "error"; readonly error: unknown };

export class Agent {
  name: string;
  sessionId: string;
  systemPrompt?: string;
  tools: ToolSet;

  store: AgentStore;
  hooks: HooksManager;
  extensionApi: HookContext;

  apiKey: string;
  apiUrl: string;
  providerId: string;
  provider: OpenAICompatibleProvider;

  context: AgentContext;
  session: AgentSession;

  readonly #abortController = new AbortController();
  /**
   * 扩展管理器。工具、hook 和系统提示片段在注册时立即生效；扩展自己的
   * 资源由扩展持有，Agent 不关心。
   */
  readonly extensions: ExtensionManager;
  /** 同一个 agent 同时只跑一个 turn。 */
  #running = false;
  /** 本 turn 拼接好的系统提示；turn 开始前算一次，turn 内保持稳定。 */
  #instructions?: string;
  /** 当前 turn 的压缩记账。 */
  #compactionsThisTurn = 0;
  #currentTurnId?: string;
  /** 本次运行的 id；step 行用它区分当前运行与历史。 */
  #streamId?: string;
  #lastCompactionGuard?: { messageCount: number; tokens: number };
  /** 是否追加了新的 user turn；只有这种情况下才允许回合开始前的压缩。 */
  #startedFromUserTurn = false;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.sessionId = options.sessionId;
    this.systemPrompt = options.systemPrompt;
    this.tools = options.tools ?? {};
    this.store = options.store;
    this.hooks = options.hooks ?? new HooksManager();
    this.extensionApi = options.extensionApi ?? {};
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.providerId = options.providerId;

    this.context = options.context;
    this.context.modelId = options.modelId;
    this.context.modelEffort = options.modelEffort;
    // 这一轮的 abort scope 属于跑它的 agent：`abort()` 是入口，每一步都从 context
    // 上把 signal 读回去。子 agent 由父把自己的 signal 传进来，两者取并集——父一停
    // 它就跟着停，而它自己的 `abort()` 仍然独立生效。
    this.context.abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, this.#abortController.signal])
      : this.#abortController.signal;
    this.session = options.session;
    this.extensions = new ExtensionManager({
      agent: {
        name: this.name,
        sessionId: this.sessionId,
        projectDirs: this.context.projectDirs,
        sessionDir: this.context.sessionDir,
      },
      tools: this.tools,
      registerTool: (name, tool) => {
        this.registerTool(name, tool);
      },
      unregisterTool: (name) => {
        this.unregisterTool(name);
      },
      hooks: this.hooks,
    });
    this.provider = createOpenAICompatible({
      apiKey: this.apiKey,
      baseURL: this.apiUrl,
      name: this.providerId,
    });
  }

  registerTool(name: string, tool: Tool) {
    this.tools[name] = tool;
  }

  unregisterTool(name: string) {
    // oxlint-disable-next-line typescript/no-dynamic-delete
    delete this.tools[name];
  }

  /**
   * 注册一个扩展。工具、hook 和系统提示片段在 `init` 期间立即生效；扩展
   * 自己加载的资源保存在扩展实例上。
   */
  async registerExtension(extension: Extension): Promise<void> {
    await this.extensions.add(extension);
    this.#syncPromptSections();
  }

  /** 卸载一个扩展；返回它是否存在。 */
  async disposeExtension(id: string): Promise<boolean> {
    const disposed = await this.extensions.dispose(id);
    this.#syncPromptSections();
    return disposed;
  }

  /** 按注册的逆序卸载全部扩展。 */
  async dispose(): Promise<void> {
    await this.extensions.disposeAll();
    this.#syncPromptSections();
  }

  /**
   * 把当前的提示片段快照写进上下文，子 agent 派生时从这里继承。主 agent
   * 自己每次 `stream()` 都从管理器重新拼接，所以这里只是为了让子 agent
   * 拿到和父一致的片段。
   */
  #syncPromptSections(): void {
    this.context.systemPromptSections = this.extensions.listSections();
  }

  /**
   * Stops the turn this agent is running: the model call in flight, the tool
   * calls it has open, and the step loop all watch this signal. The turn still
   * finishes — with `status: "aborted"` — so the reader sees an ending.
   */
  abort(): void {
    this.#abortController.abort();
  }

  #getModel() {
    return this.provider.chatModel(this.context.modelId);
  }

  async stream(options: AgentStreamOptions) {
    if (this.#running) {
      throw new Error("agent is already running");
    }
    this.#running = true;
    this.#streamId = options.streamId;
    try {
      return await this.#startStream(options);
    } catch (error) {
      // turn 还没交给后台任务就失败了，把锁还回去。
      this.#running = false;
      throw error;
    }
  }

  async #startStream(options: AgentStreamOptions) {
    if (options.signal.type === "compaction") {
      return await this.#startCompactionStream(options);
    }
    return await this.#startTurnStream(options);
  }

  /**
   * Builds the stream a run produces into, with the writes the run needs.
   *
   * `start` runs synchronously when the stream is constructed, so `write` is
   * usable as soon as this returns. Every write also feeds the turn builder
   * when there is one; the compaction run and the turn run both report through
   * the same channel, which is what lets one reader follow either.
   */
  #createEventStream({
    persistSteps = false,
  }: { persistSteps?: boolean } = {}): {
    stream: ReadableStream<AgentStreamEvent<AgentToolSet>>;
    write: (event: AgentStreamEvent<AgentToolSet>) => Promise<void>;
    close: () => void;
    fail: (error: unknown) => void;
  } {
    let controller!: ReadableStreamDefaultController<
      AgentStreamEvent<AgentToolSet>
    >;

    const stream = new ReadableStream<AgentStreamEvent<AgentToolSet>>({
      start(controllerArg) {
        controller = controllerArg;
      },
    });

    return {
      stream,
      write: async (event) => {
        try {
          await this.session.builder?.push(event);
          if (persistSteps) {
            await this.#persistStepEvent(event);
          }
          controller.enqueue(event);
        } catch {
          // suppress errors when the stream has been closed
        }
      },
      close: () => {
        try {
          controller.close();
        } catch {
          // suppress errors when the stream has been closed
        }
      },
      fail: (error) => {
        try {
          controller.error(error);
        } catch {
          // suppress errors when the stream has been closed
        }
      },
    };
  }

  /**
   * 在 step 到达终态、或被终态更新时写一行 step。
   *
   * 只处理 `journaledStepTarget` 认可的事件；其余事件不写库。写失败只告警，
   * 不打断流——回合本身仍然可以正常收尾。
   */
  async #persistStepEvent(
    event: AgentStreamEvent<AgentToolSet>
  ): Promise<void> {
    const target = journaledStepTarget(event);
    if (!target) {
      return;
    }

    const step = this.session.builder?.getStep(target.stepId);
    const turn = this.session.turns.find(
      (candidate) => candidate.id === target.turnId
    );
    if (!step || !turn) {
      return;
    }

    const seq = turn.content.findIndex((candidate) => candidate.id === step.id);
    if (seq === -1) {
      return;
    }

    const row: StepInsertModel = {
      id: step.id,
      turnId: target.turnId,
      sessionId: this.sessionId,
      seq,
      streamId: this.#streamId ?? null,
      type: step.type,
      status: step.status,
      content: step,
      createdAt: new Date(step.createdAt),
      updatedAt: new Date(),
    };

    try {
      await this.store.saveStep(row);
    } catch (error) {
      logger.warn("[agent] failed to persist step", error);
    }
  }

  async #startTurnStream({ turns, modelId, onFinish }: AgentStreamOptions) {
    this.context.modelId = modelId;
    this.session.turns = turns;
    // 提示片段在 turn 开始时拼一次：同一 turn 的每一步看到同一份提示词，
    // 扩展在 turn 中途改数据也不会让后续步骤的缓存失效。
    this.#instructions = this.extensions.renderSystemPrompt(
      this.systemPrompt ?? ""
    );

    const mostRecentTurn = turns.at(-1);
    if (!mostRecentTurn) {
      throw new Error("no message.");
    }
    this.#startedFromUserTurn = mostRecentTurn.type === "user";

    await this.hooks.emit(
      "session_start",
      {
        sessionId: this.sessionId,
        name: this.name,
        projectDirs: this.context.projectDirs,
        sessionDir: this.context.sessionDir,
      },
      this.extensionApi
    );

    const session = await this.store.getSessionById(this.sessionId);
    if (!session) {
      // The title stays empty until the AI-generated one lands; the UI
      // renders a localized placeholder for empty titles, so no hardcoded
      // (language-specific) default is stored here.
      await this.store.saveSession({
        id: this.sessionId,
        title: "",
        metadata: {},
        projectId: this.context.projectId,
      });
    }

    const originalTurns = turns;
    let lastTurnId = turns.at(-2)?.id;

    if (mostRecentTurn?.type === "user") {
      await this.store.saveTurn({
        id: mostRecentTurn.id,
        sessionId: this.sessionId,
        type: "user",
        metadata: {},
        parentId: lastTurnId,
        content: mostRecentTurn,
        createdAt: new Date(),
      });
      lastTurnId = mostRecentTurn.id;
      await this.store.setActiveHead(this.sessionId, mostRecentTurn.id);
    }

    const { stream, write, close, fail } = this.#createEventStream({
      persistSteps: true,
    });

    // Started, not awaited: the turn runs as a producer into `stream` while the
    // caller begins reading it. Awaiting here would run the whole turn to
    // completion first — the stream's queue never blocks, so every chunk would
    // sit buffered until the last one had already been produced.
    void (async () => {
      // Anything else that ends the turn — a throw out of `#runTurn`, a turn
      // that never produced a record — is a failure the session should show.
      let outcome: SessionEndStatus = "error";

      try {
        this.context.controller = {
          write,
          close,
          error: fail,
        };

        const turnId = await this.session.startTurn({
          turns: originalTurns,
        });

        const turn = await this.#runTurn({
          turnType: "assistant",
          title: session?.title,
          turnId,
          parentId: lastTurnId,
        });

        this.session.finishTurn({ turn });

        if (turn) {
          outcome = TURN_END_TO_SESSION_STATUS[turn.status];
        }

        this.context.controller?.close();
      } catch (error) {
        // A step reports its own ending through the turn's finish event; this
        // covers the rest of the turn — the store writes around it in
        // particular — which would otherwise reject unobserved and leave the
        // reader waiting for a stream that never ends.
        fail(error);
      } finally {
        this.#running = false;
        await this.hooks.emit(
          "session_end",
          { sessionId: this.sessionId },
          this.extensionApi
        );
        onFinish(outcome);
      }
    })();

    return stream;
  }

  /**
   * Runs a manual compaction as a stream of its own.
   *
   * It is the same producer/consumer shape as a turn: the caller gets a stream
   * back at once, the summary runs in the background, and the marker is written
   * before the stream closes — so a reader that reaches the end can fetch the
   * branch and find it. The plan is made before the stream exists, which is what
   * lets a caller answer "nothing to compact" synchronously and keep the lock
   * until the run has actually started.
   *
   * The turn the stream reports is an independent `compaction` turn. It is
   * always appended and becomes the active head; `recent` records its cut
   * point in the record instead of splicing itself into the middle of the
   * branch, so the stored turn list stays linear.
   */
  async #startCompactionStream(options: AgentStreamOptions) {
    const { turns, modelId, signal, onFinish } = options;
    if (signal.type !== "compaction") {
      throw new Error("not a compaction signal");
    }

    this.context.modelId = modelId;
    await this.session.loadTurns({ turns });

    const policy = this.#policy();
    const plan = planManualCompaction(turns, this.session.projected, policy);
    if (!plan?.parentTurnId) {
      throw new NothingToCompactError();
    }

    const turnId = generateTurnId();
    const stepId = generateStepId();
    const compactionId = generateEventId();
    const startedAt = Date.now();
    const { stream, write, close, fail } = this.#createEventStream();
    this.context.controller = { write, close, error: fail };

    void (async () => {
      let outcome: SessionEndStatus = "error";

      try {
        // 标记先以 streaming 出现，长摘要期间读者能看到它在进行；失败时
        // compaction.error 会把这个 part（以及只为它存在的 step）撤回。
        await write({
          type: "turn.start",
          id: turnId,
          turnType: "compaction",
          createdAt: startedAt,
        });
        await write({
          type: "step.start",
          id: stepId,
          turnId,
          stepType: "compaction",
          model: modelId,
          createdAt: startedAt,
        });
        await write({
          type: "compaction.start",
          id: compactionId,
          trigger: signal.trigger,
          turnId,
          stepId,
          createdAt: startedAt,
        });
        await this.hooks.emit(
          "compaction:start",
          { sessionId: this.sessionId, trigger: signal.trigger },
          this.extensionApi
        );

        const result = await compactHistory({
          projected: this.session.projected,
          policy,
          trigger: signal.trigger,
          modelId,
          summarize: this.#summarize(),
          region: plan.region,
          signal: this.context.abortSignal,
        });
        if (!result) {
          throw new CompactionError("compaction produced no record");
        }

        // 手工压缩的 part 与记录共用一个 id：时间线上的这个标记只有一个身份。
        // 切点写进记录，压缩 turn 本身只做线性追加。
        const record: CompactionRecord = {
          ...result.record,
          id: compactionId,
          ...(plan.retainedFromTurnId
            ? { retainedFromTurnId: plan.retainedFromTurnId }
            : {}),
        };
        const completedAt = Date.now();

        const turn: AgentCompactionTurn = {
          id: turnId,
          type: "compaction",
          createdAt: startedAt,
          completedAt,
          status: "done",
          content: [
            {
              id: stepId,
              type: "compaction",
              createdAt: startedAt,
              completedAt,
              status: "done",
              model: modelId,
              content: [
                {
                  type: "compaction",
                  id: compactionId,
                  state: "done",
                  createdAt: startedAt,
                  completedAt,
                  record,
                },
              ],
            },
          ],
        };

        await write({
          type: "compaction.end",
          id: compactionId,
          turnId,
          stepId,
          record,
          createdAt: completedAt,
        });
        await write({
          id: stepId,
          turnId,
          type: "step.finish",
          createdAt: completedAt,
          usage: ZERO_USAGE,
          finishReason: "stop",
          rawFinishReason: "stop",
          providerMetadata: undefined,
          status: "done",
        });
        await write({
          id: turnId,
          type: "turn.finish",
          createdAt: completedAt,
          usage: ZERO_USAGE,
          status: "done",
        });

        await this.store.insertTurnInBranch({
          turn: {
            id: turn.id,
            sessionId: this.sessionId,
            type: "compaction",
            metadata: {},
            content: turn,
            parentId: plan.parentTurnId,
            createdAt: new Date(turn.createdAt),
          },
        });

        await this.hooks.emit(
          "compaction:end",
          { sessionId: this.sessionId, record },
          this.extensionApi
        );
        outcome = "done";
      } catch (error) {
        outcome = this.context.abortSignal?.aborted ? "canceled" : "error";
        // 历史没有改，标记也不该留下：撤回到 start 之前的样子。
        await write({
          type: "compaction.error",
          id: compactionId,
          error: getErrorMessage(error),
          createdAt: Date.now(),
        });
      } finally {
        this.#running = false;
        try {
          // 先落定会话行再关流：读者读到结尾时，branch 和 activeStreamId
          // 都已经是一致的。
          await onFinish(outcome);
        } finally {
          close();
        }
      }
    })();

    return stream;
  }

  async generateSessionTitle(
    turnId: string,
    modelId: string,
    turn: AgentTurn<AgentToolSet>
  ) {
    try {
      const stepId = generateStepId();
      await this.context.controller?.write({
        type: "step.start",
        stepType: "session.title",
        model: modelId,
        turnId,
        id: stepId,
        createdAt: Date.now(),
      });

      const eventId = generateEventId();
      await this.context.controller?.write({
        id: eventId,
        type: "session.title.start",
        turnId,
        stepId,
        createdAt: Date.now(),
      });

      const step = await generateText({
        // The turn may be reusing a `context.modelId` that a later call has
        // already replaced, so the model is resolved from the argument.
        model: this.provider.chatModel(modelId),
        system: TITLE_PROMPT,
        prompt: this.getTextFromUserTurn(turn),
      });
      const title = step.text;

      await this.store.updateSessionById(this.sessionId, title);

      await this.context.controller?.write({
        id: eventId,
        type: "session.title.end",
        title,
        turnId,
        stepId,
        createdAt: Date.now(),
      });

      await this.context.controller?.write({
        id: stepId,
        turnId,
        type: "step.finish",
        createdAt: Date.now(),
        usage: step.usage,
        finishReason: step.finalStep.finishReason,
        rawFinishReason: step.finalStep.rawFinishReason,
        providerMetadata: step.finalStep.providerMetadata,
        status: "done",
        metadata: { performance: step.finalStep.performance },
      });

      await this.hooks.emit(
        "title_generated",
        { sessionId: this.sessionId, title },
        this.extensionApi
      );
      return title;
    } catch (error) {
      logger.warn("[agent] failed to generate session title", error);
    }
  }

  getTextFromUserTurn(turn: AgentTurn<AgentToolSet>): string {
    return turn.content
      .filter((step) => step.type === "user")
      .flatMap((step) => step.content.filter((e) => e.type === "text"))
      .map((part) => part.text)
      .join("");
  }

  toAgentTurns(turns: TurnRecord[]): AgentTurn<AgentToolSet>[] {
    return turns.map((e) => e.content);
  }

  /**
   * Drives one assistant turn: repeated `#runStep` calls until the model stops
   * asking for tools, the step budget runs out, or a step is aborted or fails.
   *
   * The loop is driven by hand: each step issues its own `streamText` call, so
   * tool execution and approval handling stay outside the SDK's step loop and
   * every step sees the history the loop has built so far.
   *
   * Every step streams into the single UI message started by
   * {@link Agent.stream}; the finish is written once, by `#finishTurn`, because
   * only after the last step is "last" known.
   */
  /**
   * 在 `turn.start` 之前把 turn 行写成 `streaming`。
   *
   * 新回合插入一条空 turn；审批恢复复用内存里已有的 turn（它可能已经带
   * step），只把 status 拉回 streaming。parentId 和 createdAt 由 store 的
   * upsert 保留，所以同一次审批恢复仍然落在原来的 branch 节点上。
   */
  async #beginTurn(
    turnId: string,
    input: AgentTurnInput,
    startedAt: number
  ): Promise<void> {
    const resumed = this.session.turns.find((turn) => turn.id === turnId);
    if (resumed) {
      resumed.status = "streaming";
      resumed.completedAt = undefined;
    }

    const content: AgentTurn<AgentToolSet> = resumed ?? {
      id: turnId,
      type: "assistant",
      createdAt: startedAt,
      status: "streaming",
      content: [],
    };

    await this.store.beginTurn({
      turn: {
        id: turnId,
        sessionId: this.sessionId,
        type: content.type,
        metadata: {},
        parentId: input.parentId ?? null,
        createdAt: new Date(content.createdAt),
        content,
      },
    });
  }

  async #runTurn(
    input: AgentTurnInput
  ): Promise<AgentTurn<AgentToolSet> | undefined> {
    const { turnId, title } = input;

    this.#compactionsThisTurn = 0;
    this.#lastCompactionGuard = undefined;
    this.#currentTurnId = turnId;

    // 在 assistant turn 打开之前执行，让标记落在上一条回复末尾：新的用户消息
    // 保持原文。
    if (this.#startedFromUserTurn) {
      await this.#maybeCompact({ trigger: "pressure", mode: "before-turn" });
    }

    // 先把 turn 行写成 streaming 再发 turn.start：这一行是崩溃标记，必须在
    // 任何 step 事件之前就存在。
    const startedAt = Date.now();
    await this.#beginTurn(turnId, input, startedAt);

    await this.context.controller?.write({
      type: "turn.start",
      id: turnId,
      turnType: "assistant",
      createdAt: startedAt,
    });

    // Start title generation in the background (never awaited)
    if (!title) {
      const userTurn = this.session.turns.findLast((e) => e.type === "user");
      if (userTurn) {
        this.generateSessionTitle(turnId, this.context.modelId, userTurn);
      }
    }

    let status: AgentTurnStatus = { status: "done" };
    let firstStep = true;
    while (true) {
      if (!firstStep) {
        await this.#maybeCompact({ trigger: "pressure", mode: "end" });
      }
      firstStep = false;

      const stepId = generateStepId();

      const outcome = await this.#runStep({
        ...input,
        stepId,
        stepType: "assistant",
      });

      if (!outcome.ok) {
        if (outcome.reason === "aborted") {
          status = { status: "aborted" };
        } else {
          status = { status: "error", error: outcome.error };
          status.error =
            status.error instanceof APICallError
              ? status.error.responseBody
              : getErrorMessage(status.error);
        }
        break;
      }

      this.session.finishStep(outcome.result);

      // The step asked the user for something, so the turn stops here rather
      // than with it: a step is what the loop continues from, and it cannot
      // continue past a call nobody has answered yet.
      if (outcome.result.awaitingApproval) {
        status = { status: "wait_review" };
        break;
      }

      if (!outcome.result.toolCallsResolved) {
        status = { status: "done" };
        break;
      }
    }

    await this.context.controller?.write({
      id: turnId,
      type: "turn.finish",
      createdAt: Date.now(),
      usage: this.session.usage,
      ...status,
    });

    // 终态先单独落一行：收尾循环还要 settle 并同步 step，进程在两者之间退出
    // 时 turn 行不应该还停在 streaming。写失败只告警，收尾循环会再写一次。
    const finishedTurn = this.session.turns.find((turn) => turn.id === turnId);
    if (finishedTurn) {
      try {
        await this.store.updateTurnHeader(turnId, finishedTurn);
      } catch (error) {
        logger.warn("[agent] failed to persist turn header", error);
      }
    }

    // An aborted or failed step returns from `#runStep` before its
    // `step.finish`, so the step and its parts are still pending here; the
    // `turn.finish` above only clears the turn. Settling first keeps the copy
    // persisted below from carrying a `"streaming"` step forever. A `"done"`
    // turn is skipped so a still-streaming background title is not marked —
    // and so is one held for approval, whose step did reach its own end.
    if (status.status === "aborted" || status.status === "error") {
      this.session.builder?.settle(status.status);
    }

    // Every turn the stream changed is written back, not just the one that
    // finished: a stream that resumes a held call runs that call and reports
    // its result against the turn that asked for it — a turn that ended turns
    // ago — so writing back only the ending would leave the store holding the
    // unanswered state of a call that has since been answered.
    const changedTurns = this.session.builder?.changedTurns ?? [];

    for (const changed of changedTurns) {
      if (await this.store.existsTurn(changed.id)) {
        await this.store.updateTurn(changed.id, changed);
      } else {
        await this.store.saveTurn({
          id: changed.id,
          sessionId: this.sessionId,
          type: changed.type,
          metadata: {},
          content: changed,
          parentId: input.parentId ?? null,
          createdAt: new Date(changed.createdAt),
        });
        await this.store.setActiveHead(this.sessionId, changed.id);
      }
    }

    // The turn this run drove, which is the one whose ending the session
    // reports — not simply the last one changed, because an earlier turn can be
    // touched after it.
    return changedTurns.findLast((changed) => changed.id === turnId);
  }

  /**
   * Runs one step: issues a single `streamText` call, pipes its chunks into the
   * open UI message, and folds the step's assistant and tool messages back into
   * the history so the next step sees them.
   *
   * Reports how the step ended rather than failing the stream: an aborted or
   * failed step is an ending the turn has to record, not a reason for the reader
   * to be left without one.
   */
  async #runStep(input: AgentStepInput): Promise<StepOutcome> {
    const { turnId, stepId } = input;
    const model = this.#getModel();
    const messages = this.session.modelMessages;

    await this.context.controller?.write({
      type: "step.start",
      stepType: "assistant",
      model: this.context.modelId,
      turnId,
      id: stepId,
      createdAt: Date.now(),
    });

    // 处理工具调用
    // A stream that carries approvals is a resumption: a previous turn's step
    // stopped with calls the user has now answered, and those calls run here,
    // before the model is asked anything, so the history the model is about to
    // read has their results in it.
    //
    // `tool:before` had its say when the calls were held — the answers are what
    // decides them now, which is why the approved ids are handed over rather
    // than the hooks being asked the same question twice.
    const { approvedToolApprovals, deniedToolApprovals } =
      collectToolApprovals<AgentToolSet>({ messages });

    if (approvedToolApprovals.length > 0 || deniedToolApprovals.length > 0) {
      const toolCallId =
        approvedToolApprovals[0]?.toolCall.toolCallId ||
        deniedToolApprovals[0]?.toolCall.toolCallId;
      const result = findToolPartByToolCallId(this.session.turns, toolCallId);
      const askedTurnId = result?.turn.id ?? turnId;
      const askedStepId = result?.step.id ?? stepId;

      const localDeniedToolApprovals = deniedToolApprovals.filter(
        (toolApproval) => toolApproval.toolCall.providerExecuted !== true
      );
      const localDeniedToolApprovalsWithoutResults =
        localDeniedToolApprovals.filter(
          (toolApproval) => toolApproval.existingToolResult === undefined
        );
      const deniedProviderExecutedToolApprovals = deniedToolApprovals.filter(
        (toolApproval) => toolApproval.toolCall.providerExecuted === true
      );

      for (const toolApproval of [
        ...localDeniedToolApprovals,
        ...deniedProviderExecutedToolApprovals,
      ]) {
        await this.context.controller?.write({
          type: "tool.output-denied",
          turnId: askedTurnId,
          stepId: askedStepId,
          createdAt: Date.now(),
          toolCallId: toolApproval.toolCall.toolCallId,
          toolName: toolApproval.toolCall.toolName,
          providerExecuted: false,
        } as AgentStreamEvent<AgentToolSet>);
      }

      const localApprovedToolApprovals = approvedToolApprovals.filter(
        (toolApproval) => toolApproval.toolCall.providerExecuted !== true
      );
      const localToolContent: ToolContent = [];

      if (localApprovedToolApprovals.length > 0) {
        const execution = await executeToolCalls({
          tools: this.tools,
          toolCalls: localApprovedToolApprovals.map(
            (toolApproval) => toolApproval.toolCall
          ),
          sessionId: this.sessionId,
          turnId: askedTurnId,
          stepId: askedStepId,
          messages,
          context: this.context,
          hooks: this.hooks,
          extensionApi: this.extensionApi,
          abortSignal: this.context.abortSignal,
          write: (event) =>
            this.context.controller?.write(event) ?? Promise.resolve(),
          skipApproval: true,
        });

        for (const message of execution.toolMessages) {
          if (message.role === "tool") {
            localToolContent.push(...message.content);
          }
        }

        if (result) {
          const previousPerformance = result?.step.metadata?.performance;
          const performance = {
            ...previousPerformance,
            toolExecutionMs: {
              ...previousPerformance?.toolExecutionMs,
              ...execution.toolExecutionMs,
            },
          } as StepResultPerformance;

          await this.context.controller?.write({
            id: askedStepId,
            turnId: askedTurnId,
            type: "step.metadata",
            createdAt: Date.now(),
            metadata: { performance },
          });
        }
      }

      // A refusal the user gave is reported to the model as an execution that
      // was turned down, which is what the SDK's own loop would have written.
      for (const toolApproval of localDeniedToolApprovalsWithoutResults) {
        localToolContent.push({
          type: "tool-result",
          toolCallId: toolApproval.toolCall.toolCallId,
          toolName: toolApproval.toolCall.toolName,
          output: {
            type: "execution-denied",
            reason: toolApproval.approvalResponse.reason,
          },
        });
      }

      if (localToolContent.length > 0) {
        messages.push({
          role: "tool",
          content: localToolContent,
        });
      }

      // 将调用完的工具结果保存
      const turn = this.session.turns.find((e) => e.id === askedTurnId);
      if (turn) {
        this.store.updateTurn(turn.id, turn);
      }
    }

    // 大模型调用
    let result;
    try {
      result = streamText<ToolSet, AgentRuntimeContext>({
        instructions: this.#instructions,
        model,
        // The SDK is given tools it can only describe: an `execute` in this set
        // would have it run the calls itself, out of `tool:before`'s reach.
        tools: stripToolExecution(this.tools),
        stopWhen: isStepCount(1),
        reasoning: this.context.modelEffort
          ? MODEL_EFFORT_TO_REASONING[this.context.modelEffort]
          : undefined,
        messages,
        abortSignal: this.context.abortSignal,
        include: {
          requestBody: true,
        },
      });
    } catch (error) {
      console.error(
        "agent#runStep streamText error.",
        this.context.abortSignal?.aborted,
        error
      );
      return await this.#stepFailure(error);
    }

    // A provider that fails mid-stream reports it as an `error` chunk, which the
    // protocol forwards as a part; keeping the last one lets the turn carry the
    // reason, which is known nowhere else.
    let streamError: unknown;

    // 大模型流处理
    const reader = result.stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value.type === "error") {
          streamError = value.error;
          console.error(
            "agent#runStep stream event error",
            this.context.abortSignal?.aborted,
            value.error
          );
        }
        // `streamText` is called with the plain `ToolSet`, so its chunks are
        // typed that way; the protocol wants them as the agent's own tool set.
        const event = toAgentEvent<AgentToolSet>(
          turnId,
          stepId,
          value as TextStreamPart<AgentToolSet>
        );
        if (event) {
          await this.context.controller?.write(event);
        }
      }
    } catch (error) {
      console.error(
        "agent#runStep reader error.",
        this.context.abortSignal?.aborted,
        streamError,
        error
      );
      // An abort surfaces here as the stream is torn down.
      return this.context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : await this.#stepFailure(streamError ?? error);
    } finally {
      reader.releaseLock();
    }

    try {
      const [step, responseMessages] = await Promise.all([
        result.finalStep,
        result.responseMessages,
      ]);
      const { finishReason, rawFinishReason, usage, toolCalls } = step;

      // The step did end, but a step the model ended with `error` has no calls
      // worth running and cannot be reported as a whole turn either.
      if (finishReason === "error") {
        await this.context.controller?.write({
          id: stepId,
          turnId,
          type: "step.finish",
          createdAt: Date.now(),
          usage: step.usage,
          finishReason: step.finishReason,
          rawFinishReason: step.rawFinishReason,
          providerMetadata: step.providerMetadata,
          status: "done",
          metadata: { performance: step.performance },
        });

        return await this.#stepFailure(
          streamError ?? new Error("The model stream failed.")
        );
      }

      // The calls this loop owns. A provider-executed call arrives with its
      // result already attached, and one the model got wrong is the SDK's to
      // report: it emits a `tool.error` of its own for those, but no matching
      // tool message, which is why they can never count as answered below.
      const clientToolCalls = toolCalls.filter(
        (call) => call.providerExecuted !== true
      );

      const execution = await executeToolCalls({
        tools: this.tools,
        toolCalls: clientToolCalls.filter((call) => call.invalid !== true),
        sessionId: this.sessionId,
        turnId,
        stepId,
        messages,
        context: this.context,
        hooks: this.hooks,
        extensionApi: this.extensionApi,
        abortSignal: this.context.abortSignal,
        write: (event) =>
          this.context.controller?.write(event) ?? Promise.resolve(),
      });

      // A stop during the calls is the turn's ending, not a step's: the run
      // returns the way the reader loop's abort does, leaving the step pending
      // for `settle` to close. The events above have already been sent, so the
      // calls that did finish are on the reader's screen.
      if (this.context.abortSignal?.aborted) {
        return { ok: false, reason: "aborted" };
      }

      await this.context.controller?.write({
        id: stepId,
        turnId,
        type: "step.finish",
        createdAt: Date.now(),
        usage: step.usage,
        // The SDK times only the tools it runs itself, and these are no longer
        // among them, so the durations come from the loop that ran them.
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        providerMetadata: step.providerMetadata,
        status: "done",
        metadata: {
          performance: {
            ...step.performance,
            toolExecutionMs: {
              ...step.performance.toolExecutionMs,
              ...execution.toolExecutionMs,
            },
          },
        },
      });

      // What the SDK feeds its own next step: the assistant message for this
      // step, then a tool message for whatever the loop executed.
      const promptMessageCount = messages.length;
      messages.push(...responseMessages, ...execution.toolMessages);
      this.session.noteStepUsage(usage, promptMessageCount);

      // The step ends here either way — everything it streamed is on the wire —
      // but a held step ends the turn with it: the model has no results to read
      // and the user still has the calls to answer, which is the next stream.
      if (execution.awaitingApproval) {
        return {
          ok: true,
          result: {
            messages,
            usage,
            finishReason,
            rawFinishReason,
            toolCallsResolved: false,
            awaitingApproval: true,
          },
        };
      }

      // The continuation rule, read off our own outcomes now that the SDK no
      // longer reports them: keep going only while every client tool call came
      // back. A denial is an answer — the model is told the call was refused —
      // but a call the model got wrong is not, and continuing there would send
      // an assistant tool call with no matching tool message.
      const toolCallsResolved =
        clientToolCalls.length > 0 &&
        clientToolCalls.every((call) => call.invalid !== true) &&
        execution.outcomes.length === clientToolCalls.length;

      return {
        ok: true,
        result: {
          messages,
          usage,
          finishReason,
          rawFinishReason,
          toolCallsResolved,
          awaitingApproval: false,
        },
      };
    } catch (error) {
      console.error(
        "agent#runStep stream final error.",
        this.context.abortSignal?.aborted,
        streamError,
        error
      );
      // The stream can fail before any step is recorded, which rejects the two
      // promises above instead of ending the reader loop.
      return this.context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : await this.#stepFailure(streamError ?? error);
    }
  }

  #policy(): ResolvedCompactionPolicy {
    return this.context.compaction ?? resolveCompactionPolicy();
  }

  #summarize(): SummarizeFn {
    return this.context.summarize ?? createSummarizer(this.#getModel());
  }

  #overheadTokens(): number {
    // usage 锚点已经覆盖 instructions 和工具 schema；这个估算只在第一步回报
    // 真实数量之前有意义。
    return estimateTokens(this.#instructions ?? "") + 2000;
  }

  /** 历史中是否存在尚未返回结果的工具调用。 */
  #hasUnresolvedToolCall(messages: readonly ModelMessage[]): boolean {
    const calls = new Set<string>();
    const results = new Set<string>();

    for (const message of messages) {
      if (typeof message.content === "string") {
        continue;
      }
      for (const part of message.content) {
        if (part.type === "tool-call") {
          calls.add(part.toolCallId);
        } else if (part.type === "tool-result") {
          results.add(part.toolCallId);
        }
      }
    }

    for (const id of calls) {
      if (!results.has(id)) {
        return true;
      }
    }
    return false;
  }

  async #stepFailure(error: unknown): Promise<StepOutcome> {
    if (this.context.abortSignal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    if (await this.#handleOverflow(error)) {
      return {
        ok: false,
        reason: "error",
        error: new Error(
          "The model's context window was exceeded. The history has been compacted; retry the request."
        ),
      };
    }

    return { ok: false, reason: "error", error };
  }

  async #handleOverflow(error: unknown): Promise<boolean> {
    if (!isContextOverflowError(error)) {
      return false;
    }

    try {
      return await this.#maybeCompact({
        trigger: "overflow",
        mode: "end",
      });
    } catch (compactionError) {
      logger.warn("[agent] overflow compaction failed", compactionError);
      return false;
    }
  }

  /**
   * 尝试缩短当前会话的模型历史：先按策略剪枝旧工具结果，必要时再摘要压缩历史。
   *
   * `pressure` 表示常规的上下文压力检查：仅在启用自动压缩、达到压缩阈值且本 turn
   * 未超过重试上限时继续。`overflow` 表示模型调用已遇到上下文溢出，不受自动压缩
   * 开关和每 turn 次数上限限制，但仍须通过工具调用完整性、可压缩区间等检查。
   *
   * `before-turn` 将当前历史中最近 user turn 之前的消息作为摘要候选区间，并把压缩
   * 标记放在新 turn 之前；`end` 则将当前 turn 末尾作为候选区间和标记插入位置。
   * 两种模式都会保留候选区间之后的消息，让下一次模型请求使用 checkpoint 加保留段。
   *
   * 成功时把压缩记录写回会话、替换模型侧历史，并更新本 turn 的计数和防重复压缩
   * 标记。失败或不满足条件时返回 `false`；但剪枝发生在摘要尝试之前，因此即使后续
   * 不压缩，已经剪掉工具结果的 `modelMessages` 也会保留。压力压缩是优化，不应仅因
   * 无法压缩而中断当前 turn。
   *
   * @param input 压缩触发原因，以及压缩标记相对于当前 turn 的放置模式。
   * @returns 是否成功完成并应用了摘要压缩。
   */
  async #maybeCompact(input: {
    trigger: "pressure" | "overflow";
    mode: "before-turn" | "end";
  }): Promise<boolean> {
    const policy = this.#policy();
    // 压力压缩可由配置关闭；溢出恢复则仍然尝试，避免失去恢复上下文的机会。
    if (input.trigger === "pressure" && !policy.auto) {
      return false;
    }
    // 同一 turn 设上限，防止压缩后仍触发压力检查时不断重复摘要。
    if (
      input.trigger === "pressure" &&
      this.#compactionsThisTurn >= MAX_COMPACTIONS_PER_TURN
    ) {
      return false;
    }

    let messages = this.session.modelMessages;
    if (policy.pruneToolResults) {
      // 先移除/截短较旧的工具结果；若产生新数组，立即同步模型侧会话历史。
      const pruned = pruneOlderToolResults(messages, {
        keepRecentTokens: policy.keepRecentTokens,
        thresholdChars: policy.pruneThresholdChars,
        headChars: policy.pruneHeadChars,
        tailChars: policy.pruneTailChars,
      });
      if (pruned !== messages) {
        messages = pruned;
        this.session.modelMessages = pruned;
      }
    }

    // 使用最新的 provider usage（若尚无则估算），并把 instructions 等固定开销计入。
    const measurement = measureContext({
      messages,
      usage: this.session.lastUsage,
      overheadTokens: this.#overheadTokens(),
    });
    // 常规压力触发必须达到阈值；overflow 触发即使尚未达到估算阈值也继续恢复。
    if (
      input.trigger === "pressure" &&
      !shouldCompact(measurement.tokens, policy)
    ) {
      return false;
    }
    // 如果历史长度没有增长、但压缩后仍超阈值，跳过重复的无进展压缩。
    if (
      input.trigger === "pressure" &&
      this.#lastCompactionGuard !== undefined &&
      messages.length <= this.#lastCompactionGuard.messageCount &&
      measurement.tokens >= (policy.thresholdTokens ?? Number.POSITIVE_INFINITY)
    ) {
      return false;
    }
    // 不能在工具调用尚未返回结果时改写历史，否则会留下不完整的工具交互。
    if (
      this.#hasUnresolvedToolCall(messages) ||
      findTurnWithoutToolResult(this.session.turns) !== null
    ) {
      return false;
    }

    let placement: { turnId: string; stepIndex: number };
    let regionEnd: number;
    if (input.mode === "before-turn") {
      // 找到下一个 turn 前可写入压缩 step 的位置；只摘要最近 user turn 之前的历史。
      const found = findPreTurnPlacement(this.session.turns);
      const { lastUserTurn } = this.session.projected;
      if (!found || !lastUserTurn) {
        return false;
      }
      placement = found;
      regionEnd = lastUserTurn.messageIndex;
    } else {
      // turn 收尾或 overflow 恢复时，将压缩标记挂到当前 assistant turn 的末尾。
      if (!this.#currentTurnId) {
        return false;
      }
      const found = findEndPlacement(this.session.turns, this.#currentTurnId);
      if (!found) {
        return false;
      }
      placement = found;
      regionEnd = messages.length;
    }

    // checkpoint 本身位于消息 0，不纳入新摘要；否则重复压缩可能摘要已有摘要。
    const start = this.session.projected.checkpoint ? 1 : 0;
    if (
      estimateMessagesTokens(messages.slice(start, regionEnd)) <
      policy.minSummarizeTokens
    ) {
      return false;
    }

    // 先开出 compaction step 与 part，再调用压缩流水线；后者拿到精确的候选区间
    // 和取消信号。part 从 start 起就以 streaming 存在，摘要失败时由
    // compaction.error 把它和这个 step 一起撤回。
    const compactionId = generateEventId();
    const stepId = generateStepId();
    const createdAt = Date.now();
    await this.context.controller?.write({
      type: "step.start",
      stepType: "compaction",
      model: this.context.modelId,
      turnId: placement.turnId,
      id: stepId,
      createdAt,
    });
    await this.context.controller?.write({
      type: "compaction.start",
      id: compactionId,
      trigger: input.trigger,
      turnId: placement.turnId,
      stepId,
      createdAt,
    });
    await this.hooks.emit(
      "compaction:start",
      { sessionId: this.sessionId, trigger: input.trigger },
      this.extensionApi
    );

    try {
      const result = await compactHistory({
        projected: {
          ...this.session.projected,
          messages,
          usageAnchor: this.session.lastUsage,
        },
        policy,
        trigger: input.trigger,
        modelId: this.context.modelId,
        summarize: this.#summarize(),
        region: { start, end: regionEnd },
        signal: this.context.abortSignal,
      });
      if (!result) {
        // 区间在进入流水线前已经校验过，理论上不会走到这里；真到了就把刚开出的
        // part 撤回，避免留下一个永远 streaming 的标记。
        await this.context.controller?.write({
          type: "compaction.error",
          id: compactionId,
          error: "compaction produced no record",
          createdAt: Date.now(),
        });
        return false;
      }

      // 记录写到 start 时开出的 step/part 上，让存储和 turn builder 都能重建该标记。
      // 结束时间要重新读：step.start 的 createdAt 早于摘要调用，不能拿它当耗时终点。
      const completedAt = Date.now();
      await this.context.controller?.write({
        type: "compaction.end",
        id: compactionId,
        turnId: placement.turnId,
        stepId,
        record: result.record,
        createdAt: completedAt,
      });
      await this.context.controller?.write({
        id: stepId,
        turnId: placement.turnId,
        type: "step.finish",
        createdAt: completedAt,
        usage: ZERO_USAGE,
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        status: "done",
      });

      // builder 通常会因上述事件追加 step；无 controller 时也显式更新 turn，保持测试
      // 和其他轻量调用方看到的会话状态一致。
      const turn = this.session.turns.find(
        (candidate) => candidate.id === placement.turnId
      );
      if (
        turn?.type === "assistant" &&
        !turn.content.some((step) => step.id === stepId)
      ) {
        turn.content.push(createCompactionStep(result.record));
      }

      // checkpoint 替代被摘要区间，区间之后的消息原样保留。
      const nextMessages = [result.checkpoint, ...messages.slice(regionEnd)];
      this.session.applyCompaction({
        checkpoint: result.record,
        messages: nextMessages,
      });
      this.#compactionsThisTurn += 1;
      this.#lastCompactionGuard = {
        messageCount: nextMessages.length,
        tokens: result.record.tokensAfter,
      };

      // before-turn 的压缩 step 不一定属于当前正在构建的 turn，因此显式持久化更新。
      if (input.mode === "before-turn" && turn) {
        await this.store.updateTurn(turn.id, turn);
      }

      await this.hooks.emit(
        "compaction:end",
        { sessionId: this.sessionId, record: result.record },
        this.extensionApi
      );
      return true;
    } catch (error) {
      if (this.context.abortSignal?.aborted) {
        return false;
      }
      // 摘要/持久化异常作为可恢复的压缩失败记录；不把压力压缩失败升级为 turn 失败。
      logger.warn("[agent] compaction failed", error);
      await this.context.controller?.write({
        type: "compaction.error",
        id: compactionId,
        error: getErrorMessage(error),
        createdAt: Date.now(),
      });
      return false;
    }
  }
}
