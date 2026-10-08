import type { AgentToolSet } from "@workspace/agent";
import type {
  AgentAssistantTurn,
  AgentPart,
  AgentTextPart,
} from "@workspace/agent-client";
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
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/frame";
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
  turn: AgentAssistantTurn<AgentToolSet>;
  onFork?: (messageId: string) => void;
};

/** Max characters of the first line used as a Frame title. */
const REASON_TOOL_LABEL_MAX_LENGTH = 180;

/**
 * Share of the screen one Frame in a step may take. A Frame holds its own
 * scroll, so a long tool output or a streaming answer fills this much of the
 * screen and then scrolls inside itself instead of growing the dialog.
 */
const STEP_FRAME_MAX_HEIGHT = "60vh";

const getReasonToolLabel = (text: string | undefined, fallback: string) => {
  const firstLine = text
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return fallback;
  }

  return firstLine.length > REASON_TOOL_LABEL_MAX_LENGTH
    ? `${firstLine.slice(0, REASON_TOOL_LABEL_MAX_LENGTH)}…`
    : firstLine;
};

/** Formats a tool step label, omitting the suffix while its detail is unknown. */
const toolStepLabel = (action: string, detail?: string) =>
  detail ? `${action} ${detail}` : action;

const splitAssistantMessageSteps = (turn: AgentAssistantTurn<AgentToolSet>) => {
  const parts: AgentPart<AgentToolSet>[] = turn.content.flatMap(
    (e) => e.content as AgentPart<AgentToolSet>[]
  );
  const answerPartIndex = parts.findLastIndex((part) => part.type === "text");

  const answerPart: AgentTextPart | undefined =
    answerPartIndex !== -1
      ? (parts[answerPartIndex] as AgentTextPart)
      : undefined;
  const stepParts: AgentPart<AgentToolSet>[] = parts.slice(0, answerPartIndex);

  return {
    stepParts,
    answerPart,
  };
};

export const AssistantMessage = ({
  loading,
  turn,
  onFork,
}: AssistantMessageProps) => {
  if (turn.type !== "assistant") {
    return null;
  }

  const isTouch = useTouchPrimary();

  const { answerPart, stepParts } = splitAssistantMessageSteps(turn);

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
                  label={getReasonToolLabel(part.text, "Text")}
                  status={part.state === "streaming" ? "active" : "complete"}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Text</FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.text}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <MessageResponse
                        controls={{
                          code: {
                            copy: true,
                            download: false,
                          },
                          table: {
                            copy: true,
                            download: false,
                            fullscreen: false,
                          },
                          mermaid: {
                            copy: true,
                            download: false,
                            fullscreen: false,
                            panZoom: true,
                          },
                        }}
                      >
                        {part.text}
                      </MessageResponse>
                    </FramePanel>
                  </Frame>
                </ChainOfTurnStep>
              );
            } else if (part.type === "reasoning") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={BrainIcon}
                  label={getReasonToolLabel(part.text, "Reasoningt")}
                  status={part.state === "streaming" ? "active" : "complete"}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>
                        <div>Reasoning</div>
                      </FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.text}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <MessageResponse
                        controls={{
                          code: {
                            copy: true,
                            download: false,
                          },
                          table: {
                            copy: true,
                            download: false,
                            fullscreen: false,
                          },
                          mermaid: {
                            copy: true,
                            download: false,
                            fullscreen: false,
                            panZoom: true,
                          },
                        }}
                      >
                        {part.text}
                      </MessageResponse>
                    </FramePanel>
                  </Frame>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-read-file") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={EyeIcon}
                  label={toolStepLabel("Read", part.input?.path)}
                  status="complete"
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>
                        <div>Reasoning</div>
                      </FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                  </Frame>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-write-file") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={PenLineIcon}
                  label={toolStepLabel("Create", part.input?.path)}
                  status="complete"
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>
                        <div>Reasoning</div>
                      </FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                  </Frame>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-grep") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={PenLineIcon}
                  label={toolStepLabel("Grep", part.input?.pattern)}
                  status="complete"
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>
                        <div>Reasoning</div>
                      </FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                  </Frame>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-glob") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={PenLineIcon}
                  label={toolStepLabel("Glob", part.input?.pattern)}
                  status="complete"
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>
                        <div>Reasoning</div>
                      </FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                  </Frame>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-web-fetch") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={GlobeIcon}
                  label={toolStepLabel("Fetch", part.input?.url)}
                  status="complete"
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>
                        <div>Reasoning</div>
                      </FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                  </Frame>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-load-skill") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={EyeIcon}
                  label={toolStepLabel("Load skill", part.input?.skill)}
                  status="complete"
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>{part.input?.skill}</FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <MessageResponse
                        controls={{
                          code: {
                            copy: true,
                            download: false,
                          },
                          table: {
                            copy: true,
                            download: false,
                            fullscreen: false,
                          },
                          mermaid: {
                            copy: true,
                            download: false,
                            fullscreen: false,
                            panZoom: true,
                          },
                        }}
                      >
                        {part.output?.output ?? ""}
                      </MessageResponse>
                    </FramePanel>
                  </Frame>
                </ChainOfTurnStep>
              );
            } else if (part.type === "tool-bash") {
              return (
                <ChainOfTurnStep
                  key={i}
                  path={`${i}`}
                  icon={SquareTerminalIcon}
                  label={toolStepLabel("Bash", part.input?.description)}
                  status="complete"
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>
                        {toolStepLabel("Bash", part.input?.description)}
                      </FrameTitle>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.input?.command ?? ""}
                        />
                      </div>
                    </FrameHeader>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.input?.command ?? ""}
                      </div>
                    </FramePanel>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                  </Frame>
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
              <TooltipTrigger render={<div />}>
                <CopyButton
                  className="text-muted-foreground"
                  size="icon-sm"
                  variant="ghost"
                  label="Copy"
                  message={answerPart.text}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p>Copy to clipboard</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <MessageAction
            onClick={() => onFork?.(turn.id)}
            className="text-muted-foreground"
          >
            <SplitIcon />
          </MessageAction>
        </MessageActions>
      )}
    </div>
  );
};
