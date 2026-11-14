import type {
  AgentCompactionTurn,
  AgentStreamEvent,
  AgentTurnStatus,
  CompactionRecord,
} from "@workspace/agent-client";
import { getErrorMessage } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";

import type { AgentContext } from "../agent-context";
import type { AgentSession } from "../agent-session";
import { CompactionError, compactHistory } from "../compaction/compact";
import { planManualCompaction } from "../compaction/select";
import type { ExtensionManager } from "../extensions/manager";
import type {
  HookContext,
  HooksManager,
  RuntimeSettings,
  StepStartEvent,
} from "../hooks-manager";
import { applyRuntimeSettingsPatches } from "../hooks-manager";
import type { AgentStore, SessionEndStatus } from "../storage";
import type { AgentToolSet } from "../types";
import {
  generateEventId,
  generateStepId,
  generateTurnId,
} from "../utils/id-util";
import type { CompactionController } from "./compaction-controller";
import type { AgentStreamOptions, AgentStreamSignal } from "./run-types";
import { NothingToCompactError } from "./run-types";
import type { TranscriptJournal } from "./transcript-journal";
import type { TurnRunner } from "./turn-runner";
import { ZERO_USAGE } from "./usage";

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

export interface RunControllerDeps {
  name: string;
  sessionId: string;
  session: AgentSession;
  context: AgentContext;
  store: AgentStore;
  hooks: HooksManager;
  extensionApi: HookContext;
  extensions: ExtensionManager;
  turnRunner: TurnRunner;
  compaction: CompactionController;
  journal: TranscriptJournal;
  /** Agent 上的基础系统提示；扩展片段会追加在它后面。 */
  baseInstructions(): string | undefined;
}

/**
 * 一次运行的生命周期。
 *
 * 它决定流什么时候开、什么时候关，`onFinish` 和关闭的先后，以及运行锁。
 * turn 内部的循环在 {@link TurnRunner}，压缩策略在
 * {@link CompactionController}，落库在 {@link TranscriptJournal}。
 */
export class RunController {
  readonly #deps: RunControllerDeps;
  #running = false;
  #streamId?: string;
  #streamKind?: AgentStreamSignal["type"];
  /** 本 turn 拼接好的系统提示；turn 开始前算一次，turn 内保持稳定。 */
  #instructions?: string;

  constructor(deps: RunControllerDeps) {
    this.#deps = deps;
  }

  get streamId(): string | undefined {
    return this.#streamId;
  }

  /**
   * 正在运行的流类型；空闲或结束时为 undefined。
   *
   * 服务端用它判断 steering 是否可用：只有普通回合还有下一步可以接收引导
   * 消息，手工压缩没有。
   */
  get streamKind(): AgentStreamSignal["type"] | undefined {
    return this.#running ? this.#streamKind : undefined;
  }

  /** turn / step 的默认运行时设置；hook 补丁在这个对象上合并。 */
  runtimeSettings(): RuntimeSettings {
    return {
      model: this.#deps.context.model,
      instructions: this.#instructions ?? "",
    };
  }

  /** 当前 turn 拼好的系统提示；压缩估算固定开销时读它。 */
  instructions(): string {
    return this.#instructions ?? "";
  }

  async stream(
    options: AgentStreamOptions
  ): Promise<ReadableStream<AgentStreamEvent<AgentToolSet>>> {
    if (this.#running) {
      throw new Error("agent is already running");
    }
    this.#running = true;
    this.#streamId = options.streamId;
    this.#streamKind = options.signal.type;
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
   * usable as soon as this returns. Every write also feeds the turn assembler
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
          await this.#deps.session.assembler?.push(event);
          if (persistSteps) {
            await this.#deps.journal.noteStep(event);
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

  async #startTurnStream({
    turns,
    model,
    onFinish,
    inboxId,
  }: AgentStreamOptions) {
    const {
      session,
      context,
      store,
      hooks,
      extensionApi,
      extensions,
      turnRunner,
    } = this.#deps;
    context.model = model;
    session.turns = turns;
    // 提示片段在 turn 开始时拼一次：同一 turn 的每一步看到同一份提示词，
    // 扩展在 turn 中途改数据也不会让后续步骤的缓存失效。
    this.#instructions = extensions.renderInstructions(
      this.#deps.baseInstructions() ?? ""
    );

    const mostRecentTurn = turns.at(-1);
    if (!mostRecentTurn) {
      throw new Error("no message.");
    }
    const startedFromUserTurn = mostRecentTurn.type === "user";

    // turn_start 的返回值可以覆盖这个 turn 的模型和系统提示。用
    // emitAsyncHooks 收集全部补丁：emit 只留最后一个返回值，会丢掉前面
    // 扩展的贡献。
    const runtime = applyRuntimeSettingsPatches(
      this.runtimeSettings(),
      await hooks.emitAsyncHooks(
        "turn_start",
        {
          sessionId: this.#deps.sessionId,
          name: this.#deps.name,
          projectDirs: context.projectDirs,
          sessionDir: context.sessionDir,
          model: context.model,
        },
        extensionApi
      )
    );
    context.model = runtime.model;
    this.#instructions = runtime.instructions;

    const sessionRow = await store.getSessionById(this.#deps.sessionId);
    if (!sessionRow) {
      // The title stays empty until the AI-generated one lands; the UI
      // renders a localized placeholder for empty titles, so no hardcoded
      // (language-specific) default is stored here.
      await store.saveSession({
        id: this.#deps.sessionId,
        title: "",
        metadata: {},
        projectId: context.projectId,
      });
    }

    const originalTurns = turns;
    let lastTurnId = turns.at(-2)?.id;

    if (mostRecentTurn?.type === "user") {
      await store.saveTurn(
        {
          id: mostRecentTurn.id,
          sessionId: this.#deps.sessionId,
          type: "user",
          metadata: {},
          parentId: lastTurnId,
          content: mostRecentTurn,
          createdAt: new Date(),
        },
        { inboxId, head: true }
      );
      lastTurnId = mostRecentTurn.id;
    }

    const { stream, write, close, fail } = this.#createEventStream({
      persistSteps: true,
    });

    // Started, not awaited: the turn runs as a producer into `stream` while the
    // caller begins reading it. Awaiting here would run the whole turn to
    // completion first — the stream's queue never blocks, so every chunk would
    // sit buffered until the last one had already been produced.
    void (async () => {
      // Anything else that ends the turn — a throw out of the turn runner, a
      // turn that never produced a record — is a failure the session should show.
      let outcome: SessionEndStatus = "error";

      try {
        context.controller = {
          write,
          close,
          error: fail,
        };

        const turnId = await session.startTurn({
          turns: originalTurns,
          assemblers: extensions.listAssemblers(),
        });

        const turn = await turnRunner.run({
          turnType: "assistant",
          turnId,
          parentId: lastTurnId,
          startedFromUserTurn,
        });

        session.finishTurn({ turn });

        if (turn) {
          outcome = TURN_END_TO_SESSION_STATUS[turn.status];
        }
      } catch (error) {
        // A step reports its own ending through the turn's finish event; this
        // covers the rest of the turn — the store writes around it in
        // particular — which would otherwise reject unobserved and leave the
        // reader waiting for a stream that never ends.
        fail(error);
      } finally {
        // 先 settle 再关流：读者读到结尾时，会话行和 activeStreamId 已经一致。
        // 这和手工压缩的收尾顺序相同，`whenFinished` 因此不会早于落定。
        try {
          await hooks.emit(
            "turn_end",
            { sessionId: this.#deps.sessionId },
            extensionApi
          );
          await onFinish(outcome);
        } catch (error) {
          logger.warn("[agent] failed to settle the turn", error);
        } finally {
          this.#running = false;
          close();
        }
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
    const { turns, model, signal, onFinish } = options;
    if (signal.type !== "compaction") {
      throw new Error("not a compaction signal");
    }

    const { session, context, store, hooks, extensionApi, compaction } =
      this.#deps;
    context.model = model;
    await session.loadTurns({ turns });

    const policy = compaction.policy();
    const plan = planManualCompaction(turns, session.projected, policy);
    if (!plan?.parentTurnId) {
      throw new NothingToCompactError();
    }

    const turnId = generateTurnId();
    const stepId = generateStepId();
    const compactionId = generateEventId();
    const startedAt = Date.now();
    const { stream, write, close, fail } = this.#createEventStream();
    context.controller = { write, close, error: fail };

    void (async () => {
      let outcome: SessionEndStatus = "error";
      const stepEvent: StepStartEvent = {
        sessionId: this.#deps.sessionId,
        turnId,
        stepId,
        stepType: "compaction",
        model,
      };

      try {
        // 标记先以 streaming 出现，长摘要期间读者能看到它在进行；失败时
        // compaction.error 会把这个 part（以及只为它存在的 step）撤回。
        await write({
          type: "turn.start",
          turnId,
          turnType: "compaction",
          createdAt: startedAt,
        });
        const stepStart = await hooks.emitAsyncHooks(
          "step_start",
          stepEvent,
          extensionApi
        );
        const { model: stepModelId } = applyRuntimeSettingsPatches(
          { model, instructions: "" },
          stepStart
        );
        stepEvent.model = stepModelId;
        await write({
          type: "step.start",
          stepId,
          turnId,
          stepType: "compaction",
          model: stepModelId.modelId,
          providerId: stepModelId.providerId,
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
        await hooks.emit(
          "pre_compact",
          { sessionId: this.#deps.sessionId, trigger: signal.trigger },
          extensionApi
        );

        const result = await compactHistory({
          projected: session.projected,
          policy,
          trigger: signal.trigger,
          modelId: stepModelId.modelId,
          summarize: compaction.summarize(stepModelId),
          region: plan.region,
          signal: context.abortSignal,
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
              model: stepModelId.modelId,
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
          stepId,
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
          turnId,
          type: "turn.finish",
          createdAt: completedAt,
          usage: ZERO_USAGE,
          status: "done",
        });

        await store.saveTurn(
          {
            id: turn.id,
            sessionId: this.#deps.sessionId,
            type: "compaction",
            metadata: {},
            content: turn,
            parentId: plan.parentTurnId,
            createdAt: new Date(turn.createdAt),
          },
          { head: true }
        );

        await hooks.emit(
          "post_compact",
          { sessionId: this.#deps.sessionId, record },
          extensionApi
        );
        outcome = "done";
      } catch (error) {
        outcome = context.abortSignal?.aborted ? "canceled" : "error";
        // 历史没有改，标记也不该留下：撤回到 start 之前的样子。
        await write({
          type: "compaction.error",
          id: compactionId,
          error: getErrorMessage(error),
          createdAt: Date.now(),
        });
      } finally {
        try {
          await hooks.emit(
            "step_end",
            {
              ...stepEvent,
              status: outcome === "canceled" ? "aborted" : outcome,
              ...(outcome === "done"
                ? { usage: ZERO_USAGE, finishReason: "stop" }
                : {}),
            },
            extensionApi
          );
          // 先落定会话行再关流：读者读到结尾时，branch 和 activeStreamId
          // 都已经是一致的。
          await onFinish(outcome);
        } catch (error) {
          logger.warn("[agent] failed to settle the compaction", error);
        } finally {
          this.#running = false;
          close();
        }
      }
    })();

    return stream;
  }
}
