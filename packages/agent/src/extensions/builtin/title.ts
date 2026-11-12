import type { AgentTurn } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";
import type { StepResultPerformance } from "ai";

import type {
  HookContext,
  HooksManager,
  StepEndEvent,
  StepStartEvent,
  TurnCreatedEvent,
} from "../../hooks-manager";
import { applyRuntimeSettingsPatches } from "../../hooks-manager";
import type { ModelGateway } from "../../kernel/model-gateway";
import type { AgentStore } from "../../storage";
import type { AgentToolSet } from "../../types";
import { generateEventId, generateStepId } from "../../utils/id-util";
import { Capabilities } from "../capabilities";
import type { EventWriter } from "../capabilities";
import type { ExtensionAPI } from "../types";
import { Extension } from "../types";

export const TITLE_PROMPT = `Generate a very short session title (2-5 words max) based on the user's message.
Rules:
- Maximum 30 characters
- No quotes, colons, hashtags, or markdown
- Just the topic/intent, not a full sentence
- If the message is a greeting like "hi" or "hello", respond with just "New conversation"
- Be concise: "Weather in NYC" not "User asking about the weather in New York City"`;

/** hook 处理器拿不到宿主上下文，这里给一个空实现。 */
const NO_HOOK_CONTEXT: HookContext = {};

interface TitleDeps {
  readonly model: ModelGateway;
  readonly store: AgentStore;
  readonly events: EventWriter;
  readonly hooks: HooksManager;
  readonly turns: () => readonly AgentTurn<AgentToolSet>[];
  readonly abortSignal: () => AbortSignal | undefined;
}

/**
 * 会话标题的生成。
 *
 * 它在 `turn_created` 时启动一次后台生成：标题是会话的元数据，不参与回合
 * 结束，所以调用方不等待它，失败也只记日志。已命名的会话（子会话带着
 * description 创建）直接跳过。
 *
 * 生成的每一步都走协议事件（`step.start` / `session.title.*` / `step.finish`），
 * 这样标题出现在流里，装配器和刷新后的界面都能重建它。
 */
export class TitleExtension extends Extension {
  init(api: ExtensionAPI): void {
    const transcript = api.use(Capabilities.transcript);
    const abortSignal = api.use(Capabilities.abortSignal);
    const deps: TitleDeps = {
      model: api.use(Capabilities.model),
      store: api.use(Capabilities.store),
      events: api.use(Capabilities.events),
      hooks: api.use(Capabilities.hooks),
      turns: () => transcript.turns(),
      abortSignal,
    };

    api.on("turn_created", (event) => {
      // 后台任务：处理器立即返回，标题在后台落库。
      void this.#generate(deps, event);
    });
  }

  async #generate(deps: TitleDeps, event: TurnCreatedEvent): Promise<void> {
    const { sessionId, turnId, model } = event;

    const session = await deps.store.getSessionById(sessionId);
    if (session?.title) {
      return;
    }

    const userTurn = deps.turns().findLast((turn) => turn.type === "user");
    if (!userTurn) {
      return;
    }

    const stepId = generateStepId();
    const stepEvent: StepStartEvent = {
      sessionId,
      turnId,
      stepId,
      stepType: "session.title",
      model,
    };
    let status: StepEndEvent["status"] = "error";

    try {
      const stepStart = await deps.hooks.emitAsyncHooks(
        "step_start",
        stepEvent,
        NO_HOOK_CONTEXT
      );
      const { model: stepModel } = applyRuntimeSettingsPatches(
        { model, instructions: "" },
        stepStart
      );
      stepEvent.model = stepModel;

      await deps.events.write({
        type: "step.start",
        stepType: "session.title",
        model: stepModel.modelId,
        providerId: stepModel.providerId,
        turnId,
        stepId,
        createdAt: Date.now(),
      });

      const eventId = generateEventId();
      await deps.events.write({
        id: eventId,
        type: "session.title.start",
        turnId,
        stepId,
        createdAt: Date.now(),
      });

      const signal = deps.abortSignal();
      const generated = await deps.model.generateText(stepModel, {
        system: TITLE_PROMPT,
        prompt: textOfUserTurn(userTurn),
        // 标题是后台任务；回合被停时它没有理由继续跑。
        ...(signal ? { abortSignal: signal } : {}),
      });
      const title = generated.text;

      await deps.store.updateSessionById(sessionId, title);

      await deps.events.write({
        id: eventId,
        type: "session.title.end",
        title,
        turnId,
        stepId,
        createdAt: Date.now(),
      });

      await deps.events.write({
        stepId,
        turnId,
        type: "step.finish",
        createdAt: Date.now(),
        usage: generated.usage,
        finishReason: generated.finishReason,
        rawFinishReason: generated.rawFinishReason,
        providerMetadata: generated.providerMetadata,
        status: "done",
        metadata: {
          performance: generated.performance as StepResultPerformance,
        },
      });

      status = "done";
      await deps.hooks.emit(
        "step_end",
        { ...stepEvent, status },
        NO_HOOK_CONTEXT
      );

      await deps.hooks.emit(
        "session_title_generated",
        { sessionId, title },
        NO_HOOK_CONTEXT
      );
    } catch (error) {
      logger.warn("[agent] failed to generate session title", error);
    } finally {
      if (status !== "done") {
        await deps.hooks.emit(
          "step_end",
          {
            ...stepEvent,
            status: deps.abortSignal()?.aborted ? "aborted" : "error",
          },
          NO_HOOK_CONTEXT
        );
      }
    }
  }
}

/** 一个用户 turn 里的纯文本；标题只需要这段。 */
function textOfUserTurn(turn: AgentTurn<AgentToolSet>): string {
  return turn.content
    .filter((step) => step.type === "user")
    .flatMap((step) => step.content.filter((entry) => entry.type === "text"))
    .map((part) => part.text)
    .join("");
}
