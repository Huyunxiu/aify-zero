import { parsePartialJson } from "ai";
import type { ToolSet } from "ai";

import { isAgentDynamicToolPart, isAgentStaticToolPart } from "../types";
import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentCompactionPart,
  AgentCompactionStep,
  AgentCompactionTurn,
  AgentDynamicToolPart,
  AgentPart,
  AgentReasoningPart,
  AgentStep,
  AgentStreamEvent,
  AgentTextPart,
  AgentToolPart,
  AgentTurn,
  AgentUserStep,
  AgentUserTurn,
  TextStreamFinishStepEvent,
  TextStreamFinishTurnEvent,
  TextStreamStartStepEvent,
  TextStreamStartTurnEvent,
} from "../types";

export class AgentTurnBuilder<TOOLS extends ToolSet> {
  turns: AgentTurn<TOOLS>[];
  pendingTurns: Map<string, AgentTurn<TOOLS>>;
  pendingSteps: Map<string, AgentStep<TOOLS>>;
  pendingParts: Map<string, AgentPart<TOOLS>>;

  constructor({ turns }: { turns: AgentTurn<TOOLS>[] }) {
    this.turns = turns;
    this.pendingTurns = new Map<string, AgentTurn<TOOLS>>();
    this.pendingSteps = new Map<string, AgentStep<TOOLS>>();
    this.pendingParts = new Map<string, AgentPart<TOOLS>>();
  }

  async push(event: AgentStreamEvent<TOOLS>): Promise<void> {
    switch (event.type) {
      case "turn.start": {
        const turn = this.startTurn(event);
        if (turn) {
          this.turns.push(turn);
          this.pendingTurns.set(turn.id, turn);
        }
        break;
      }
      case "turn.finish": {
        const turn = this.finishTurn(event);
        if (turn) {
          this.pendingTurns.delete(turn.id);
        }
        break;
      }
      case "step.start": {
        const step = this.startStep(event);
        if (step) {
          const turn = this.pendingTurns.get(event.turnId);
          if (turn) {
            (turn.content as AgentStep<TOOLS>[]).push(step);
          }
          this.pendingSteps.set(step.id, step);
        }
        break;
      }
      case "step.finish": {
        const step = this.finishStep(event);
        if (step) {
          this.pendingSteps.delete(step.id);
        }
        break;
      }
      case "text.start": {
        const part: AgentTextPart = {
          type: "text",
          text: "",
          providerMetadata: event.providerMetadata,
          state: "streaming",
        };
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        this.pendingParts.set(uk, part);
        const step = this.pendingSteps.get(event.stepId);
        if (step) {
          (step.content as AgentPart<TOOLS>[]).push(part);
        }
        break;
      }
      case "text.delta": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.pendingParts.get(uk) as AgentTextPart | undefined;
        if (part) {
          part.text += event.text;
          part.providerMetadata =
            event.providerMetadata ?? part.providerMetadata;
        }
        break;
      }
      case "text.end": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.pendingParts.get(uk) as AgentTextPart | undefined;
        if (part) {
          part.state = "done";
          part.providerMetadata =
            event.providerMetadata ?? part.providerMetadata;
          this.pendingParts.delete(uk);
        }
        break;
      }
      case "reasoning.start": {
        const part: AgentReasoningPart = {
          type: "reasoning",
          text: "",
          providerMetadata: event.providerMetadata,
          state: "streaming",
        };
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        this.pendingParts.set(uk, part);
        const step = this.pendingSteps.get(event.stepId);
        if (step) {
          (step.content as AgentPart<TOOLS>[]).push(part);
        }
        break;
      }
      case "reasoning.delta": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.pendingParts.get(uk) as
          | AgentReasoningPart
          | undefined;
        if (part) {
          part.text += event.text;
          part.providerMetadata =
            event.providerMetadata ?? part.providerMetadata;
        }
        break;
      }
      case "reasoning.end": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.pendingParts.get(uk) as
          | AgentReasoningPart
          | undefined;
        if (part) {
          part.state = "done";
          part.providerMetadata =
            event.providerMetadata ?? part.providerMetadata;
          this.pendingParts.delete(uk);
        }
        break;
      }
      case "tool.input-start": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        if (event.dynamic) {
          const part: AgentDynamicToolPart = {
            type: "dynamic-tool",
            state: "input-streaming",
            toolCallId: event.id,
            toolName: event.toolName,
            input: undefined,
            rawInput: "",
            providerExecuted: event.providerExecuted,
            callProviderMetadata: event.providerMetadata,
            title: event.title,
            toolMetadata: event.toolMetadata,
          };
          this.pendingParts.set(uk, part);
          const step = this.pendingSteps.get(event.stepId);
          if (step) {
            (step.content as AgentPart<TOOLS>[]).push(part);
          }
        } else {
          const part: AgentToolPart<TOOLS> = {
            type: `tool-${event.toolName}`,
            state: "input-streaming",
            toolCallId: event.id,
            input: undefined,
            rawInput: "",
            providerExecuted: event.providerExecuted,
            callProviderMetadata: event.providerMetadata,
            title: event.title,
            toolMetadata: event.toolMetadata,
          };
          this.pendingParts.set(uk, part);
          const step = this.pendingSteps.get(event.stepId);
          if (step) {
            (step.content as AgentPart<TOOLS>[]).push(part);
          }
        }
        break;
      }
      case "tool.input-delta": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.pendingParts.get(uk);
        if (part) {
          if (isAgentDynamicToolPart(part)) {
            part.rawInput += event.delta;
            const { value: partialArgs } = await parsePartialJson(
              part.rawInput
            );
            part.input = partialArgs;
            part.callProviderMetadata = event.providerMetadata;
          } else if (isAgentStaticToolPart(part)) {
            part.rawInput += event.delta;
            const { value: partialArgs } = await parsePartialJson(
              part.rawInput
            );
            part.input = partialArgs;
            part.callProviderMetadata = event.providerMetadata;
          }
        }
        break;
      }
      case "tool.input-end": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.pendingParts.get(uk);
        if (part) {
          if (isAgentDynamicToolPart(part)) {
            part.state = "input-available";
            part.callProviderMetadata = event.providerMetadata;
          } else if (isAgentStaticToolPart(part)) {
            part.state = "input-available";
            part.callProviderMetadata = event.providerMetadata;
          }
        }
        break;
      }
      case "tool.call": {
        const uk = `${event.turnId}-${event.stepId}-${event.toolCallId}`;
        const part = this.pendingParts.get(uk);
        if (part) {
          if (isAgentDynamicToolPart(part)) {
            if (event.invalid) {
              part.state = "output-error";
              part.errorText =
                (event.error as string | undefined) ?? "Invalid tool call";
              part.input = event.input;
              part.title = event.title;
              part.toolCallId = event.toolCallId;
              part.toolMetadata = event.toolMetadata;
              part.toolName = event.toolName;
              part.providerExecuted = event.providerExecuted;
              part.callProviderMetadata = event.providerMetadata;
            } else {
              part.state = "input-available";
              part.input = event.input;
              part.title = event.title;
              part.toolCallId = event.toolCallId;
              part.toolMetadata = event.toolMetadata;
              part.toolName = event.toolName;
              part.providerExecuted = event.providerExecuted;
              part.callProviderMetadata = event.providerMetadata;
            }
          } else if (isAgentStaticToolPart(part)) {
            if (event.invalid) {
              part.state = "output-error";
              part.errorText =
                (event.error as string | undefined) ?? "Invalid tool call";
              part.input = event.input;
              part.title = event.title;
              part.toolCallId = event.toolCallId;
              part.toolMetadata = event.toolMetadata;
              part.providerExecuted = event.providerExecuted;
              part.callProviderMetadata = event.providerMetadata;
            } else {
              part.state = "input-available";
              part.input = event.input;
              part.title = event.title;
              part.toolCallId = event.toolCallId;
              part.toolMetadata = event.toolMetadata;
              part.providerExecuted = event.providerExecuted;
              part.callProviderMetadata = event.providerMetadata;
            }
          }
        }
        break;
      }
      case "tool.result": {
        const uk = `${event.turnId}-${event.stepId}-${event.toolCallId}`;
        const part = this.pendingParts.get(uk);
        if (part) {
          if (isAgentDynamicToolPart(part)) {
            part.state = "output-available";
            part.errorText = undefined;
            part.input = event.input;
            part.title = event.title;
            part.toolCallId = event.toolCallId;
            part.toolMetadata = event.toolMetadata;
            part.toolName = event.toolName;
            part.providerExecuted = event.providerExecuted;
            if (part.state === "output-available") {
              part.resultProviderMetadata = event.providerMetadata;
              part.preliminary = event.preliminary;
            }
            this.pendingParts.delete(uk);
          } else if (isAgentStaticToolPart(part)) {
            part.state = "output-available";
            part.errorText = undefined;
            part.input = event.input;
            part.title = event.title;
            part.toolCallId = event.toolCallId;
            part.toolMetadata = event.toolMetadata;
            part.providerExecuted = event.providerExecuted;
            if (part.state === "output-available") {
              part.resultProviderMetadata = event.providerMetadata;
              part.preliminary = event.preliminary;
            }
            this.pendingParts.delete(uk);
          }
        }
        break;
      }
      case "tool.output-denied": {
        const uk = `${event.turnId}-${event.stepId}-${event.toolCallId}`;
        const part = this.pendingParts.get(uk);
        if (part) {
          if (isAgentDynamicToolPart(part)) {
            part.state = "output-denied";
            part.toolCallId = event.toolCallId;
            part.toolName = event.toolName;
            part.providerExecuted = event.providerExecuted;
            this.pendingParts.delete(uk);
          } else if (isAgentStaticToolPart(part)) {
            part.state = "output-denied";
            part.errorText = undefined;
            part.toolCallId = event.toolCallId;
            part.providerExecuted = event.providerExecuted;
            this.pendingParts.delete(uk);
          }
        }
        break;
      }
      case "tool.error": {
        const uk = `${event.turnId}-${event.stepId}-${event.toolCallId}`;
        const part = this.pendingParts.get(uk);
        if (part) {
          if (isAgentDynamicToolPart(part)) {
            part.state = "output-error";
            part.errorText = event.error ? (event.error as string) : undefined;
            part.input = event.input;
            part.title = event.title;
            part.toolCallId = event.toolCallId;
            part.toolMetadata = event.toolMetadata;
            part.toolName = event.toolName;
            part.providerExecuted = event.providerExecuted;
            if (part.state === "output-error") {
              part.resultProviderMetadata = event.providerMetadata;
            }
            this.pendingParts.delete(uk);
          } else if (isAgentStaticToolPart(part)) {
            part.state = "output-error";
            part.errorText = event.error ? (event.error as string) : undefined;
            part.input = event.input;
            part.title = event.title;
            part.toolCallId = event.toolCallId;
            part.toolMetadata = event.toolMetadata;
            part.providerExecuted = event.providerExecuted;
            if (part.state === "output-error") {
              part.resultProviderMetadata = event.providerMetadata;
            }
            this.pendingParts.delete(uk);
          }
        }
        break;
      }
      case "compaction.start": {
        const part: AgentCompactionPart = {
          id: event.id,
          type: "compaction",
          state: "streaming",
        };
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        this.pendingParts.set(uk, part);
        const step = this.pendingSteps.get(event.stepId);
        if (step) {
          (step.content as AgentPart<TOOLS>[]).push(part);
        }
        break;
      }
      case "compaction.end": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.pendingParts.get(uk) as
          | AgentCompactionPart
          | undefined;
        if (part) {
          part.compacted = event.compacted;
          part.messages = event.messages;
          part.state = "done";
          this.pendingParts.delete(uk);
        }
        break;
      }
      case "error": {
        break;
      }
      case "abort": {
        // ignore
        break;
      }
      default: {
        console.warn(
          `AgentTurnBuilder#onEvent unknown event ${JSON.stringify(event)}`
        );
        break;
      }
    }
  }

  private startTurn(event: TextStreamStartTurnEvent): AgentTurn<TOOLS> | null {
    if (event.turnType === "user") {
      const turn: AgentUserTurn = {
        type: "user",
        id: event.id,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
      };
      return turn;
    } else if (event.turnType === "assistant") {
      const turn: AgentAssistantTurn<TOOLS> = {
        type: "assistant",
        id: event.id,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
      };
      return turn;
    } else if (event.turnType === "compaction") {
      const turn: AgentCompactionTurn = {
        type: "compaction",
        id: event.id,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
      };
      return turn;
    }

    console.error(
      `AgentTurnBuilder#startTurn unknown event ${JSON.stringify(event)}`
    );
    return null;
  }

  private finishTurn(
    event: TextStreamFinishTurnEvent
  ): AgentTurn<TOOLS> | null {
    const turn = this.pendingTurns.get(event.id);
    if (!turn) {
      return null;
    }

    turn.status = "done";
    turn.usage = event.usage;
    turn.performance = event.performance;
    turn.finishReason = event.finishReason;
    turn.rawFinishReason = event.rawFinishReason;
    turn.providerMetadata = event.providerMetadata;
    turn.completedAt = event.createdAt;
    return turn;
  }

  private startStep(event: TextStreamStartStepEvent): AgentStep<TOOLS> | null {
    if (event.stepType === "user") {
      const step: AgentUserStep = {
        type: "user",
        id: event.id,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
      };
      return step;
    } else if (event.stepType === "assistant") {
      const step: AgentAssistantStep<TOOLS> = {
        type: "assistant",
        id: event.id,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
        model: event.model,
      };
      return step;
    } else if (event.stepType === "compaction") {
      const step: AgentCompactionStep = {
        type: "compaction",
        id: event.id,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
        model: event.model,
      };
      return step;
    }

    console.error(
      `AgentTurnBuilder#startStep unknown event ${JSON.stringify(event)}`
    );
    return null;
  }

  private finishStep(
    event: TextStreamFinishStepEvent
  ): AgentStep<TOOLS> | null {
    const step = this.pendingSteps.get(event.id);
    if (!step) {
      return null;
    }

    step.status = "done";
    step.usage = event.usage;
    step.performance = event.performance;
    step.finishReason = event.finishReason;
    step.rawFinishReason = event.rawFinishReason;
    step.providerMetadata = event.providerMetadata;
    step.completedAt = event.createdAt;
    return step;
  }
}
