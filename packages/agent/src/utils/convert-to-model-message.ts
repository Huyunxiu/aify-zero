import { isNonNullable } from "@ai-sdk/provider-utils";
import type {
  ToolSet,
  AssistantContent,
  ModelMessage,
  ToolResultPart,
  ToolApprovalResponse,
} from "@ai-sdk/provider-utils";
import {
  getToolName,
  isAgentCustomContentPart,
  isAgentFilePart,
  isAgentReasoningPart,
  isAgentTextPart,
  isAgentToolPart,
} from "@workspace/agent-client";
import type {
  AgentAssistantTurn,
  AgentPart,
  AgentStep,
  AgentToolPart,
  AgentTurn,
  AgentUserTurn,
} from "@workspace/agent-client";
import { createToolModelOutput } from "ai/internal";

import { TOOL_DENIED_TEXT } from "../hooks-manager";
import { getOwn } from "./get-own";

/**
 * 把已存储的 turns 转成模型消息，但不应用压缩标记。
 *
 * 需要模型侧历史（压缩标记会把累计器重置）的调用方必须改用 `projectHistory`；
 * 这里是它依赖的原始转换器，会完全跳过 compaction turn，因此不会产出只应用了
 * 一半的历史。
 */
export async function convertAgentTurnToModalMessage<TOOLS extends ToolSet>(
  turns: AgentTurn<TOOLS>[]
): Promise<ModelMessage[]> {
  return await convertToModelMessages<TOOLS>(turns);
}

/**
 * 把单个 step 转成它贡献的模型消息。
 *
 * step 是压缩切点可能落在的单位，所以投影需要逐步转换。这里复用 turn 转换器，
 * 而不是重写一遍工具/审批处理。
 */
export async function convertStepToModelMessages<TOOLS extends ToolSet>(
  step: AgentStep<TOOLS>,
  options?: { tools?: ToolSet }
): Promise<ModelMessage[]> {
  if (step.type === "assistant") {
    const turn: AgentAssistantTurn<TOOLS> = {
      id: `step:${step.id}`,
      type: "assistant",
      createdAt: step.createdAt,
      status: "done",
      content: [step],
    };
    return await convertToModelMessages<TOOLS>([turn], options);
  }

  if (step.type === "user") {
    const turn: AgentUserTurn = {
      id: `step:${step.id}`,
      type: "user",
      createdAt: step.createdAt,
      status: "done",
      content: [step],
    };
    return await convertToModelMessages<TOOLS>([turn], options);
  }

  return [];
}

/**
 * Converts an array of UI messages from useChat into an array of ModelMessages that can be used
 * with the AI functions (e.g. `streamText`, `generateText`).
 *
 * @param turns - The UI messages to convert.
 * @param options.tools - The tools to use.
 * @param options.ignoreIncompleteToolCalls - Whether to ignore incomplete tool calls. Default is `false`.
 * @param options.convertDataPart - Optional function to convert data parts to text or file model message parts. Returns `undefined` if the part should be ignored.
 *
 * @returns An array of ModelMessages.
 */
export async function convertToModelMessages<TOOLS extends ToolSet>(
  turns: AgentTurn<TOOLS>[],
  options?: {
    tools?: ToolSet;
  }
): Promise<ModelMessage[]> {
  const modelMessages: ModelMessage[] = [];

  for (const turn of turns) {
    switch (turn.type) {
      case "user": {
        modelMessages.push({
          role: "user",
          content: turn.content
            .flatMap((step) =>
              step.content.map((part) => {
                if (isAgentTextPart(part)) {
                  return {
                    type: "text" as const,
                    text: part.text,
                    ...(part.providerMetadata
                      ? { providerOptions: part.providerMetadata }
                      : {}),
                  };
                } else if (isAgentFilePart(part)) {
                  return {
                    type: "file" as const,
                    mediaType: part.mediaType,
                    filename: part.filename,
                    data: part.providerReference
                      ? {
                          type: "reference" as const,
                          reference: part.providerReference,
                        }
                      : { type: "url" as const, url: new URL(part.url) },
                    ...(part.providerMetadata
                      ? { providerOptions: part.providerMetadata }
                      : {}),
                  };
                }

                return null;
              })
            )
            .filter(isNonNullable),
        });
        break;
      }
      case "compaction": {
        // compaction turn 是标记而不是对话；投影会在调用这个转换器之前消费它的
        // step。
        break;
      }
      case "assistant": {
        if (turn.content.length) {
          let block: AgentPart<TOOLS>[] = [];

          // oxlint-disable-next-line no-inner-declarations
          async function processBlock() {
            if (block.length === 0) {
              return;
            }

            const content: AssistantContent = [];

            for (const part of block) {
              if (isAgentTextPart(part)) {
                content.push({
                  type: "text" as const,
                  text: part.text,
                  ...(part.providerMetadata
                    ? { providerOptions: part.providerMetadata }
                    : {}),
                });
              } else if (isAgentCustomContentPart(part)) {
                content.push({
                  type: "custom" as const,
                  kind: part.kind,
                  ...(part.providerMetadata
                    ? { providerOptions: part.providerMetadata }
                    : {}),
                });
              } else if (isAgentFilePart(part)) {
                content.push({
                  type: "file" as const,
                  mediaType: part.mediaType,
                  filename: part.filename,
                  data: part.providerReference
                    ? {
                        type: "reference" as const,
                        reference: part.providerReference,
                      }
                    : { type: "url" as const, url: new URL(part.url) },
                  ...(part.providerMetadata
                    ? { providerOptions: part.providerMetadata }
                    : {}),
                });
              } else if (isAgentReasoningPart(part)) {
                content.push({
                  type: "reasoning" as const,
                  text: part.text,
                  providerOptions: part.providerMetadata,
                });
              } else if (isAgentToolPart(part)) {
                const toolName = getToolName(part);

                if (part.state !== "input-streaming") {
                  const callProviderMetadata =
                    part.callProviderMetadata ??
                    (part.state === "output-error"
                      ? part.resultProviderMetadata
                      : undefined);

                  content.push({
                    type: "tool-call" as const,
                    toolCallId: part.toolCallId,
                    toolName,
                    input: part.input,
                    providerExecuted: part.providerExecuted,
                    ...(callProviderMetadata
                      ? { providerOptions: callProviderMetadata }
                      : {}),
                  });

                  if (part.approval) {
                    content.push({
                      type: "tool-approval-request" as const,
                      approvalId: part.approval.id,
                      toolCallId: part.toolCallId,
                      isAutomatic: part.approval.isAutomatic,
                      ...(part.approval.requestReason
                        ? { reason: part.approval.requestReason }
                        : {}),
                      ...(Object.hasOwn(part.approval, "inputSchemaInput")
                        ? {
                            inputSchemaInput: part.approval.inputSchemaInput,
                          }
                        : {}),
                      ...(part.approval.signature
                        ? { signature: part.approval.signature }
                        : {}),
                    });
                  }

                  if (
                    part.providerExecuted === true &&
                    part.state !== "approval-responded" &&
                    (part.state === "output-available" ||
                      part.state === "output-error")
                  ) {
                    const resultProviderMetadata =
                      part.resultProviderMetadata ?? part.callProviderMetadata;

                    content.push({
                      type: "tool-result",
                      toolCallId: part.toolCallId,
                      toolName,
                      output: await createToolModelOutput({
                        toolCallId: part.toolCallId,
                        input: part.input,
                        output:
                          part.state === "output-error"
                            ? part.errorText
                            : part.output,
                        tool: getOwn(options?.tools, toolName),
                        errorMode:
                          part.state === "output-error" ? "json" : "none",
                      }),
                      ...(resultProviderMetadata
                        ? { providerOptions: resultProviderMetadata }
                        : {}),
                    });
                  }
                }
              } else {
                console.warn(
                  `convertToModelMessages#Unsupported part: ${JSON.stringify(part)}`
                );
              }
            }

            if (content.length > 0) {
              modelMessages.push({
                role: "assistant",
                content,
              });
            }

            // check if there are tool invocations with results in the block
            // Include non-provider-executed tools, OR provider-executed tools with approval responses
            const toolParts = block.filter(
              (part) =>
                isAgentToolPart(part) &&
                (part.providerExecuted !== true || part.approval?.approved)
            ) as AgentToolPart[];

            // tool message with tool results
            if (toolParts.length > 0) {
              const innerContent: (ToolResultPart | ToolApprovalResponse)[] =
                [];
              for (const toolPart of toolParts) {
                // add approval response for approved tool calls:
                if (toolPart.approval?.approved) {
                  innerContent.push({
                    type: "tool-approval-response" as const,
                    approvalId: toolPart.approval.id,
                    approved: toolPart.approval.approved,
                    reason: toolPart.approval.reason,
                    providerExecuted: toolPart.providerExecuted,
                  });
                }

                // add synthetic execution-denied result for denied tool approvals
                if (
                  toolPart.state === "approval-responded" &&
                  !toolPart.approval?.approved
                ) {
                  innerContent.push({
                    type: "tool-result",
                    toolCallId: toolPart.toolCallId,
                    toolName: getToolName(toolPart),
                    output: {
                      type: "execution-denied" as const,
                      reason: toolPart.approval.reason,
                    },
                    ...(toolPart.callProviderMetadata
                      ? { providerOptions: toolPart.callProviderMetadata }
                      : {}),
                  });
                }

                // For provider-executed tools, the tool result is already in the
                // assistant content. Skip adding to tool message to avoid duplicates
                // (which would create orphaned function_call_output entries).
                if (toolPart.providerExecuted === true) {
                  continue;
                }

                switch (toolPart.state) {
                  case "output-denied": {
                    innerContent.push({
                      type: "tool-result",
                      toolCallId: toolPart.toolCallId,
                      toolName: getToolName(toolPart),
                      output: {
                        type: "error-text" as const,
                        value: toolPart.approval?.reason ?? TOOL_DENIED_TEXT,
                      },
                      ...(toolPart.callProviderMetadata
                        ? { providerOptions: toolPart.callProviderMetadata }
                        : {}),
                    });
                    break;
                  }

                  case "output-error":
                  case "output-available": {
                    const toolName = getToolName(toolPart);
                    innerContent.push({
                      type: "tool-result",
                      toolCallId: toolPart.toolCallId,
                      toolName,
                      output: await createToolModelOutput({
                        toolCallId: toolPart.toolCallId,
                        input: toolPart.input,
                        output:
                          toolPart.state === "output-error"
                            ? toolPart.errorText
                            : toolPart.output,
                        tool: getOwn(options?.tools, toolName),
                        errorMode:
                          toolPart.state === "output-error" ? "text" : "none",
                      }),
                      ...(toolPart.callProviderMetadata
                        ? { providerOptions: toolPart.callProviderMetadata }
                        : {}),
                    });
                    break;
                  }
                  case "approval-requested": {
                    break;
                  }
                  case "approval-responded": {
                    break;
                  }
                  case "input-available": {
                    break;
                  }
                  case "input-streaming": {
                    break;
                  }
                  default: {
                    break;
                  }
                }
              }

              if (innerContent.length > 0) {
                modelMessages.push({
                  role: "tool",
                  content: innerContent,
                });
              }
            }

            // updates for next block
            block = [];
          }

          for (const step of turn.content) {
            // 压缩 step 和标题 step 都不是 assistant 内容。
            if (step.type !== "assistant") {
              continue;
            }
            for (const part of step.content) {
              // A call that reported part-way through — a `task` call does, so
              // a client can follow the subagent it started — has no result
              // yet, and a tool call handed to the model without one is a
              // broken turn. The part is dropped whole, call and result both:
              // the turn it sits in is still running, and the model reads it
              // once it has finished.
              //
              // Read off the state, the way the SDK reads it: a call that ended
              // in `output-error` after reporting is finished, and keeps its
              // flag from the report it made. What it has to say then is the
              // failure, and the model is told about it.
              if (
                isAgentToolPart(part) &&
                part.state === "output-available" &&
                part.preliminary
              ) {
                continue;
              }
              if (
                isAgentTextPart(part) ||
                isAgentCustomContentPart(part) ||
                isAgentReasoningPart(part) ||
                isAgentFilePart(part) ||
                isAgentToolPart(part)
              ) {
                block.push(part);
              }
            }
            await processBlock();
          }

          break;
        }

        break;
      }
      default: {
        break;
      }
    }
  }

  return modelMessages;
}
