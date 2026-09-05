import type { UseChatHelpers } from "@ai-sdk/react";
import type {
  AgentUIDataParts,
  AgentUIMessage,
  AgentUITools,
} from "@workspace/agent";
import type { TextUIPart, UIMessagePart } from "ai";
import {
  BrainIcon,
  EyeIcon,
  SplitIcon,
  GlobeIcon,
  PenLineIcon,
  SquareTerminalIcon,
  TextIcon,
} from "lucide-react";

import {
  ChainOfTurn,
  ChainOfTurnContent,
  ChainOfTurnHeader,
  ChainOfTurnStep,
} from "../components/ai-elements/chain-of-turn";
import { CopyButton } from "../components/copy-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip";
import { useTouchPrimary } from "../hooks/use-touch-primary";
import { cn } from "../lib/utils";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "./message";

type AssistantMessageProps = {
  loading?: boolean;
  message: AgentUIMessage;
  regenerate: UseChatHelpers<AgentUIMessage>["regenerate"];
  addToolOutput: UseChatHelpers<AgentUIMessage>["addToolOutput"];
  addToolApprovalResponse: UseChatHelpers<AgentUIMessage>["addToolApprovalResponse"];
  onFork?: (messageId: string) => void;
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
  loading,
  addToolOutput: _addToolOutput,
  addToolApprovalResponse: _addToolApprovalResponse,
  message,
  regenerate: _regenerate,
  onFork,
}: AssistantMessageProps) => {
  if (message.role !== "assistant") {
    return null;
  }

  const isTouch = useTouchPrimary();

  const { answerPart, stepParts } = splitAssistantMessageParts(message);

  return (
    <div className="flex flex-col gap-4 group">
      <ChainOfTurn defaultExpanded={new Set(["root"])}>
        <ChainOfTurnHeader path="root" loading={loading}>
          Working
        </ChainOfTurnHeader>
        <ChainOfTurnContent path="root">
          {stepParts.map((part, i) => {
            if (part.type === "text") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={TextIcon}
                  label={part.text}
                  status={part.state === "streaming" ? "active" : "complete"}
                >
                  <MessageResponse
                    controls={{
                      table: {
                        copy: false,
                        download: false,
                        fullscreen: false,
                      },
                    }}
                  >
                    {part.text}
                  </MessageResponse>
                </ChainOfTurnStep>
              );
            } else if (part.type === "reasoning") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={BrainIcon}
                  label="Reasoning"
                  status={part.state === "streaming" ? "active" : "complete"}
                >
                  <MessageResponse
                    controls={{
                      table: {
                        copy: false,
                        download: false,
                        fullscreen: false,
                      },
                    }}
                  >
                    {part.text}
                  </MessageResponse>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-read-file") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={EyeIcon}
                  label={`Read ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-write-file") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={PenLineIcon}
                  label={`Create ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-grep") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={PenLineIcon}
                  label={`Grep ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-glob") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={PenLineIcon}
                  label={`Glob ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-web-fetch") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={GlobeIcon}
                  label={`Fetch ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-load-skill") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={EyeIcon}
                  label={`Load skill ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-bash") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={SquareTerminalIcon}
                  label={`Grep ${part.output?.title}`}
                  status="complete"
                >
                  <div className="relative rounded-lg bg-muted p-4 whitespace-pre">
                    {part.input?.command ?? ""}
                    <br />
                    <br />
                    {part.output?.output ?? ""}
                  </div>
                </ChainOfTurnStep>
              );
            }

            return null;
          })}
        </ChainOfTurnContent>
      </ChainOfTurn>
      {answerPart && (
        <Message from="assistant">
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
      {answerPart && (
        <MessageActions
          className={cn(
            !isTouch && [
              "opacity-0 pointer-events-none transition-opacity duration-150",
              "group-hover:opacity-100 group-hover:pointer-events-auto",
              "group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
            ]
          )}
        >
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <CopyButton
                  className="text-muted-foreground"
                  size="icon-sm"
                  variant="ghost"
                  label="Copy"
                  message={answerPart}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p>Copy to clipboard</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <MessageAction
            onClick={() => onFork?.(message.id)}
            className="text-muted-foreground"
          >
            <SplitIcon />
          </MessageAction>
        </MessageActions>
      )}
    </div>
  );
};
