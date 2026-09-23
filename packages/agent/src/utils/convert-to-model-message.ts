import { isNonNullable } from "@ai-sdk/provider-utils";
import type {
  ToolSet,
  AssistantContent,
  ModelMessage,
  ToolResultPart,
} from "@ai-sdk/provider-utils";
import { createToolModelOutput } from "ai/internal";

import {
  getToolName,
  isAgentCompactionPart,
  isAgentFilePart,
  isAgentReasoningPart,
  isAgentTextPart,
  isAgentToolPart,
} from "../types";
import type {
  AgentDynamicToolPart,
  AgentPart,
  AgentStep,
  AgentToolPart,
  AgentTurn,
} from "../types";
import { getOwn } from "./get-own";

export async function convertAgentTurnToModalMessage<TOOLS extends ToolSet>(
  originalTurns: AgentTurn<TOOLS>[]
): Promise<ModelMessage[]> {
  let turns: AgentTurn<TOOLS>[] = [];

  let compactedMessages: ModelMessage[] = [];
  for (const turn of originalTurns) {
    const newTurn: AgentTurn<TOOLS> = { ...turn, content: [] };
    for (const step of turn.content) {
      const newStep: AgentStep<TOOLS> = { ...step, content: [] };
      for (const part of step.content) {
        newStep.content.push(part as any);
        if (
          isAgentCompactionPart(part) &&
          part.compacted &&
          part.messages?.length
        ) {
          compactedMessages = [];
          turns = [];
          newTurn.content = [];
          newStep.content = [];
          compactedMessages.push(...part.messages);
        }
      }

      if (newStep.content.length) {
        newTurn.content.push(newStep as any);
      }
    }

    if (newTurn.content.length) {
      turns.push(newTurn);
    }
  }

  const recentMessages = await convertToModelMessages<TOOLS>(turns);

  return [...compactedMessages, ...recentMessages];
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

                  if (
                    part.providerExecuted === true &&
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
              (part) => isAgentToolPart(part) && part.providerExecuted !== true
            ) as (AgentToolPart<TOOLS> | AgentDynamicToolPart)[];

            // tool message with tool results
            if (toolParts.length > 0) {
              const innerContent: ToolResultPart[] = [];
              for (const toolPart of toolParts) {
                // For provider-executed tools, the tool result is already in the
                // assistant innerContent. Skip adding to tool message to avoid duplicates
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
                        value: "Tool call execution denied.",
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
                  case "input-streaming":
                  case "input-available":
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
            for (const part of step.content) {
              if (
                isAgentTextPart(part) ||
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
      case "compaction": {
        break;
      }
      default: {
        break;
      }
    }
  }

  return modelMessages;
}
