import { parsePartialJson } from "ai";
import type { ToolSet } from "ai";

import {
  isAgentDynamicToolPart,
  isAgentReasoningPart,
  isAgentStaticToolPart,
  isAgentTextPart,
  isAgentToolPart,
} from "./types";
import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentCompactionPart,
  AgentCompactionStep,
  AgentCompactionTurn,
  AgentCustomContentPart,
  AgentToolPart,
  AgentPart,
  AgentReasoningPart,
  AgentSessionTitlePart,
  AgentSessionTitleStep,
  AgentStep,
  AgentStreamEvent,
  AgentTextPart,
  AgentStaticToolPart,
  AgentTurn,
  AgentUserStep,
  AgentUserTurn,
  TextStreamFinishStepEvent,
  TextStreamFinishTurnEvent,
  TextStreamStartStepEvent,
  TextStreamStartTurnEvent,
  AgentDynamicToolPart,
} from "./types";

export class AgentTurnBuilder<TOOLS extends ToolSet> {
  turns: AgentTurn<TOOLS>[];
  private readonly turnsMap: Map<string, AgentTurn<TOOLS>>;
  private readonly stepsMap: Map<string, AgentStep<TOOLS>>;
  private readonly toolParts: Map<string, AgentToolPart>;
  private readonly pendingParts: Map<string, AgentPart<TOOLS>>;
  /**
   * Compaction parts opened by `compaction.start` and not yet committed by
   * `compaction.end`, keyed by the compaction id.
   *
   * They are held separately from `pendingParts` because ending one is not
   * simply a state change: a failed attempt has to take its part — and the step
   * that exists only for it — back out again, and `compaction.error` names the
   * compaction, not the step.
   */
  private readonly pendingCompactions: Map<
    string,
    { turnId: string; stepId: string; part: AgentCompactionPart }
  >;
  /**
   * Every turn the stream has changed, in the order it first touched them.
   *
   * A turn that finished is only one of them: an event can land on a turn that
   * ended long ago — a `tool.result` answering the call it was held on rewrites
   * that turn — so a caller that has to write the transcript back cannot go by
   * the ending alone.
   *
   * Each turn is held by identity and recorded once, so a reader that arrives
   * later sees every entry as it stands then rather than as it stood when its
   * first event arrived.
   */
  changedTurns: AgentTurn<TOOLS>[] = [];
  private readonly changedTurnIds = new Set<string>();

  constructor({ turns }: { turns: AgentTurn<TOOLS>[] }) {
    this.turns = turns;
    this.pendingParts = new Map<string, AgentPart<TOOLS>>();
    this.pendingCompactions = new Map();
    this.toolParts = new Map<string, AgentToolPart>();
    this.turnsMap = new Map<string, AgentTurn<TOOLS>>();
    this.stepsMap = new Map<string, AgentStep<TOOLS>>();
    for (const turn of turns) {
      this.turnsMap.set(turn.id, turn);
      for (const step of turn.content) {
        this.stepsMap.set(step.id, step);
        for (const part of step.content) {
          if (isAgentToolPart(part)) {
            const uk = `${turn.id}-${step.id}-${part.toolCallId}`;
            this.toolParts.set(uk, part);
          }
        }
      }
    }
  }

  async push(event: AgentStreamEvent<TOOLS>): Promise<void> {
    switch (event.type) {
      case "turn.start": {
        let turn = this.turnsMap.get(event.id);
        if (turn) {
          turn.status = "streaming";
          break;
        }

        turn = this.startTurn(event);
        if (turn) {
          this.turns.push(turn);
          this.turnsMap.set(turn.id, turn);
        }
        break;
      }
      case "turn.finish": {
        this.finishTurn(event);
        break;
      }
      case "step.start": {
        let step = this.stepsMap.get(event.id);
        if (step) {
          step.status = "streaming";
          break;
        }

        step = this.startStep(event);
        if (step) {
          const turn = this.turnsMap.get(event.turnId);
          if (turn) {
            (turn.content as AgentStep<TOOLS>[]).push(step);
          }
          this.stepsMap.set(step.id, step);
        }
        break;
      }
      case "step.finish": {
        this.finishStep(event);
        break;
      }
      case "step.metadata": {
        // A step held for approval finished before its calls ran, so the
        // durations arrive later and only the performance is replaced: the
        // step's status, usage and end time are already what they should be.
        const step = this.stepsMap.get(event.id);
        if (step) {
          step.metadata = { ...step.metadata, ...event.metadata };
        }
        break;
      }
      case "text.start": {
        const part: AgentTextPart = {
          type: "text",
          text: "",
          providerMetadata: event.providerMetadata,
          state: "streaming",
          createdAt: event.createdAt,
        };
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        this.pendingParts.set(uk, part);
        const step = this.stepsMap.get(event.stepId);
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
          part.completedAt = event.createdAt;
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
          part.completedAt = event.createdAt;
          part.providerMetadata =
            event.providerMetadata ?? part.providerMetadata;
          this.pendingParts.delete(uk);
        }
        break;
      }
      case "custom": {
        const part: AgentCustomContentPart = {
          type: "custom",
          kind: event.kind,
          providerMetadata: event.providerMetadata,
        };
        const step = this.stepsMap.get(event.stepId);
        if (step) {
          (step.content as AgentPart<TOOLS>[]).push(part);
        }
        break;
      }
      case "reasoning.start": {
        const part: AgentReasoningPart = {
          type: "reasoning",
          text: "",
          providerMetadata: event.providerMetadata,
          state: "streaming",
          createdAt: event.createdAt,
        };
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        this.pendingParts.set(uk, part);
        const step = this.stepsMap.get(event.stepId);
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
          part.completedAt = event.createdAt;
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
          part.completedAt = event.createdAt;
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
          this.toolParts.set(uk, part);
          const step = this.stepsMap.get(event.stepId);
          if (step) {
            (step.content as AgentPart<TOOLS>[]).push(part);
          }
        } else {
          const part: AgentStaticToolPart<TOOLS> = {
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
          this.toolParts.set(uk, part);
          const step = this.stepsMap.get(event.stepId);
          if (step) {
            (step.content as AgentPart<TOOLS>[]).push(part);
          }
        }
        break;
      }
      case "tool.input-delta": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.toolParts.get(uk);
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
        const part = this.toolParts.get(uk);
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
      case "tool.approval-request": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.toolParts.get(uk);
        if (part && isAgentToolPart(part)) {
          part.state = "approval-requested";
          part.approval = {
            id: event.approvalId,
            ...(event.approvalDescriptor
              ? { descriptor: event.approvalDescriptor }
              : {}),
            ...(Object.hasOwn(event, "inputSchemaInput")
              ? { inputSchemaInput: event.inputSchemaInput }
              : {}),
            ...(event.reason ? { requestReason: event.reason } : {}),
            ...(event.isAutomatic === true ? { isAutomatic: true } : {}),
            ...(event.signature ? { signature: event.signature } : {}),
            createdAt: event.createdAt,
          };
        }
        break;
      }
      case "tool.approval-response": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.toolParts.get(uk);
        if (!part) {
          console.warn(
            `AgentTurnBuilder#push no tool invocation for approval response ${event.approvalId}`
          );
          break;
        }

        part.state = "approval-responded";
        part.approval = {
          ...(part.approval ?? {
            id: event.approvalId,
            createdAt: event.createdAt,
          }),
          id: event.approvalId,
          approved: event.approved,
          approvedAt: event.createdAt,
          ...(event.reason ? { reason: event.reason } : {}),
          ...(event.data ? { data: event.data } : {}),
        };
        if (event.providerExecuted) {
          part.providerExecuted = event.providerExecuted;
        }
        if (event.providerMetadata) {
          part.callProviderMetadata = event.providerMetadata;
        }
        break;
      }
      case "tool.call": {
        const uk = `${event.turnId}-${event.stepId}-${event.toolCallId}`;
        const part = this.toolParts.get(uk);
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
        const part = this.toolParts.get(uk);
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
            part.output = event.output;
            part.resultProviderMetadata = event.providerMetadata;
            part.preliminary = event.preliminary;
          } else if (isAgentStaticToolPart(part)) {
            part.state = "output-available";
            part.errorText = undefined;
            part.input = event.input;
            part.title = event.title;
            part.toolCallId = event.toolCallId;
            part.toolMetadata = event.toolMetadata;
            part.providerExecuted = event.providerExecuted;
            part.output = event.output;
            part.resultProviderMetadata = event.providerMetadata;
            part.preliminary = event.preliminary;
          }
        }
        break;
      }
      case "tool.output-denied": {
        const uk = `${event.turnId}-${event.stepId}-${event.toolCallId}`;
        const part = this.toolParts.get(uk);
        if (part) {
          if (isAgentDynamicToolPart(part)) {
            part.state = "output-denied";
            part.toolCallId = event.toolCallId;
            part.toolName = event.toolName;
            part.providerExecuted = event.providerExecuted;
          } else if (isAgentStaticToolPart(part)) {
            part.state = "output-denied";
            part.errorText = undefined;
            part.toolCallId = event.toolCallId;
            part.providerExecuted = event.providerExecuted;
          }
        }
        break;
      }
      case "tool.error": {
        const uk = `${event.turnId}-${event.stepId}-${event.toolCallId}`;
        const part = this.toolParts.get(uk);
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
            part.resultProviderMetadata = event.providerMetadata;
          } else if (isAgentStaticToolPart(part)) {
            part.state = "output-error";
            part.errorText = event.error ? (event.error as string) : undefined;
            part.input = event.input;
            part.title = event.title;
            part.toolCallId = event.toolCallId;
            part.toolMetadata = event.toolMetadata;
            part.providerExecuted = event.providerExecuted;
            part.resultProviderMetadata = event.providerMetadata;
          }
        }
        break;
      }
      case "compaction.start": {
        const step = this.stepsMap.get(event.stepId);
        if (!step || step.type !== "compaction") {
          console.warn(
            `AgentTurnBuilder#push compaction.start without a compaction step ${event.id}`
          );
          break;
        }
        const part: AgentCompactionPart = {
          type: "compaction",
          id: event.id,
          state: "streaming",
          createdAt: event.createdAt,
        };
        step.content.push(part);
        this.pendingCompactions.set(event.id, {
          turnId: event.turnId,
          stepId: event.stepId,
          part,
        });
        break;
      }
      case "compaction.end": {
        const pending = this.pendingCompactions.get(event.id);
        if (pending) {
          pending.part.state = "done";
          pending.part.completedAt = event.createdAt;
          pending.part.record = event.record;
          this.pendingCompactions.delete(event.id);
          break;
        }

        // An end without a start still commits: the record is the whole point,
        // and the step it names is enough to hold it.
        const step = this.stepsMap.get(event.stepId);
        if (!step || step.type !== "compaction") {
          console.warn(
            `AgentTurnBuilder#push compaction.end without a compaction step ${event.id}`
          );
          break;
        }
        const part: AgentCompactionPart = {
          type: "compaction",
          id: event.id,
          state: "done",
          createdAt: event.createdAt,
          record: event.record,
        };
        step.content.push(part);
        break;
      }
      case "compaction.error": {
        // The summary never arrived, so there is no marker to keep. Removing
        // the part restores the turn to what it looked like before the attempt.
        this.dropCompaction(event.id);
        break;
      }
      case "session.title.start": {
        const part: AgentSessionTitlePart = {
          id: event.id,
          type: "session.title",
          state: "streaming",
        };
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        this.pendingParts.set(uk, part);
        const step = this.stepsMap.get(event.stepId);
        if (step) {
          (step.content as AgentPart<TOOLS>[]).push(part);
        }
        break;
      }
      case "session.title.end": {
        const uk = `${event.turnId}-${event.stepId}-${event.id}`;
        const part = this.pendingParts.get(uk) as
          | AgentSessionTitlePart
          | undefined;
        if (part) {
          part.title = event.title;
          part.state = "done";
          this.pendingParts.delete(uk);
        }
        break;
      }
      case "error": {
        console.error("AgentTurnBuilder#push error", event.error);
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

    // The turn an event names is the turn it changed, so it is recorded here
    // rather than in each branch above. An event naming a part this builder
    // never opened is the one case where that overstates what happened, and a
    // caller writing back a turn whose stored state already matches is a price
    // worth paying to keep the rule in one place.
    this.markChanged(this.eventTurnId(event));
  }

  /**
   * Ends whatever the stream left unfinished.
   *
   * The `turn.finish` / `step.finish` / `*`.end events remove entries from the
   * pending maps, so they hold exactly the objects that never finished; settling
   * those is enough, and it is a no-op for a stream that ended properly, where
   * the ending arrives on the finish event instead.
   *
   * The caller supplies the outcome: a builder cannot tell from its own state
   * whether the transport failed or was cancelled — only that nothing finished.
   *
   * `status` is a union of string literals, so a plain assignment is enough; note
   * that comparing it first would narrow the union and turn the assignment into a
   * type error. Tool parts run their own state machine and are left alone.
   */
  settle(outcome: "aborted" | "error"): void {
    for (const turn of this.turnsMap.values()) {
      turn.status = outcome;
    }

    for (const step of this.stepsMap.values()) {
      step.status = outcome;
    }

    // These parts are ended here rather than by their own `*`.end event, so
    // there is no event time to take: the clock is read instead. Leaving
    // `completedAt` off a part that is already `"done"` would make the two
    // states indistinguishable to a reader that goes by the time alone.
    const now = Date.now();
    for (const part of this.pendingParts.values()) {
      if (isAgentTextPart(part) || isAgentReasoningPart(part)) {
        part.state = "done";
        part.completedAt = now;
      }
    }

    // A compaction whose summary never arrived leaves no marker: it is not a
    // part that can be "done", and keeping it streaming would claim the
    // history was cut when it was not.
    for (const id of this.pendingCompactions.keys()) {
      this.dropCompaction(id);
    }
  }

  /**
   * The turn an event belongs to.
   *
   * `turn.start` and `turn.finish` name it with `id`, because the event *is*
   * that turn's own lifecycle and belongs to no other; everything else carries
   * it in `turnId`. `abort` and `error` carry one too but change nothing in it,
   * so they are answered with `undefined`.
   */
  private eventTurnId(event: AgentStreamEvent<TOOLS>): string | undefined {
    if (event.type === "turn.start" || event.type === "turn.finish") {
      return event.id;
    }

    if (
      event.type === "abort" ||
      event.type === "error" ||
      event.type === "compaction.error"
    ) {
      return undefined;
    }

    return event.turnId;
  }

  /**
   * Takes back a compaction part that was opened but never committed.
   *
   * The step goes with it when it is left empty: the compaction step exists
   * only to hold this part, so keeping a bare step would leave a boundary in
   * the turn that does not mark anything.
   */
  private dropCompaction(id: string): void {
    const pending = this.pendingCompactions.get(id);
    if (!pending) {
      return;
    }
    this.pendingCompactions.delete(id);

    const step = this.stepsMap.get(pending.stepId);
    if (!step || step.type !== "compaction") {
      return;
    }

    const partIndex = step.content.findIndex((part) => part.id === id);
    if (partIndex !== -1) {
      step.content.splice(partIndex, 1);
    }
    if (step.content.length > 0) {
      return;
    }

    this.stepsMap.delete(step.id);
    const turn = this.turnsMap.get(pending.turnId);
    if (!turn) {
      return;
    }
    const steps = turn.content as AgentStep<TOOLS>[];
    const stepIndex = steps.findIndex((candidate) => candidate.id === step.id);
    if (stepIndex !== -1) {
      steps.splice(stepIndex, 1);
    }
  }

  /**
   * Records that a turn changed, the first time it does.
   *
   * The turn is looked up rather than built from the event: a stream can name
   * turns this builder was never seeded with, and one it does not hold is one
   * it cannot hand back.
   */
  private markChanged(turnId: string | undefined): void {
    if (!turnId || this.changedTurnIds.has(turnId)) {
      return;
    }

    const turn = this.turnsMap.get(turnId);
    if (!turn) {
      return;
    }

    this.changedTurnIds.add(turnId);
    this.changedTurns.push(turn);
  }

  private startTurn(
    event: TextStreamStartTurnEvent
  ): AgentTurn<TOOLS> | undefined {
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
    return undefined;
  }

  private finishTurn(
    event: TextStreamFinishTurnEvent
  ): AgentTurn<TOOLS> | null {
    const turn = this.turnsMap.get(event.id);
    if (!turn) {
      return null;
    }

    turn.status = event.status;
    if (event.status === "error" && turn.status === "error") {
      turn.error = event.error;
    }
    if (event.status === "aborted" && turn.status === "aborted") {
      turn.abortReason = event.abortReason;
    }
    turn.usage = event.usage;
    turn.completedAt = event.createdAt;
    return turn;
  }

  private startStep(
    event: TextStreamStartStepEvent
  ): AgentStep<TOOLS> | undefined {
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
    } else if (event.stepType === "session.title") {
      const step: AgentSessionTitleStep = {
        type: "session.title",
        id: event.id,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
        model: event.model,
      };
      return step;
    }

    console.log(
      `AgentTurnBuilder#startStep unknown event ${JSON.stringify(event)}`
    );
    return undefined;
  }

  private finishStep(
    event: TextStreamFinishStepEvent
  ): AgentStep<TOOLS> | null {
    const step = this.stepsMap.get(event.id);
    if (!step) {
      return null;
    }

    step.status = event.status;
    if (event.status === "error" && step.status === "error") {
      step.error = event.error;
    }
    if (event.status === "aborted" && step.status === "aborted") {
      step.abortReason = event.abortReason;
    }
    step.usage = event.usage;
    step.metadata = event.metadata;
    step.finishReason = event.finishReason;
    step.rawFinishReason = event.rawFinishReason;
    step.providerMetadata = event.providerMetadata;
    step.completedAt = event.createdAt;
    return step;
  }
}
