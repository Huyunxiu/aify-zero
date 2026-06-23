import type { UseChatHelpers } from "@ai-sdk/react";
import type {
  AgentUIDataParts,
  AgentUIMessage,
  AgentUITools,
} from "@workspace/agent";
import type { TextUIPart, UIMessagePart } from "ai";
import { BrainIcon, EyeIcon, PenLineIcon, TextIcon } from "lucide-react";

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  ChainOfThoughtStepMarkdown,
} from "../components/ai-elements/chain-of-thought";
import { Message, MessageContent, MessageResponse } from "./message";

type AssistantMessageProps = {
  message: AgentUIMessage;
  regenerate: UseChatHelpers<AgentUIMessage>["regenerate"];
  addToolOutput: UseChatHelpers<AgentUIMessage>["addToolOutput"];
  addToolApprovalResponse: UseChatHelpers<AgentUIMessage>["addToolApprovalResponse"];
};

const splitAssistantMessageParts = (message: AgentUIMessage) => {
  const answerPartIndex = message.parts.findLastIndex(
    (part) => part.type === "text"
  );

  const answerPart: TextUIPart | undefined =
    answerPartIndex !== -1
      ? (message.parts[answerPartIndex] as TextUIPart)
      : undefined;
  const stepParts: UIMessagePart<AgentUIDataParts, AgentUITools>[] =
    message.parts.slice(0, answerPartIndex);

  return {
    stepParts,
    answerPart,
  };
};

export const AssistantMessage = ({
  addToolOutput,
  addToolApprovalResponse,
  message,
  regenerate,
}: AssistantMessageProps) => {
  if (message.role !== "assistant") {
    return null;
  }

  const { answerPart, stepParts } = splitAssistantMessageParts(message);
  console.log("stepParts", stepParts);

  return (
    <div className="flex flex-col gap-4">
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>Working</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {stepParts.map((part, i) => {
            if (part.type === "text") {
              return (
                <ChainOfThoughtStepMarkdown
                  key={i}
                  icon={TextIcon}
                  label="Text"
                  description={part.text}
                  status={part.state === "streaming" ? "active" : "complete"}
                ></ChainOfThoughtStepMarkdown>
              );
            } else if (part.type === "reasoning") {
              return (
                <ChainOfThoughtStepMarkdown
                  key={i}
                  icon={BrainIcon}
                  label="Reasoning"
                  description={part.text}
                  status={part.state === "streaming" ? "active" : "complete"}
                ></ChainOfThoughtStepMarkdown>
              );
            } else if (part.type === "tool-read-file") {
              return (
                <ChainOfThoughtStep
                  key={i}
                  icon={EyeIcon}
                  label={`Read ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfThoughtStep>
              );
            } else if (part.type === "tool-write-file") {
              return (
                <ChainOfThoughtStep
                  key={i}
                  icon={PenLineIcon}
                  label={`Create ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            return null;
          })}
        </ChainOfThoughtContent>
      </ChainOfThought>
      {answerPart && (
        <Message from="assistant" key={`${-1}`}>
          <MessageContent>
            <MessageResponse
              controls={{
                table: {
                  copy: false,
                  download: false,
                  fullscreen: false,
                },
              }}
            >
              {answerPart.text}
            </MessageResponse>
          </MessageContent>
        </Message>
      )}
    </div>
  );
};
