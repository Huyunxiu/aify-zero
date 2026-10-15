import type { AgentToolSet } from "@workspace/agent";
import { isAgentToolPart } from "@workspace/agent-client";
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
  SquareTerminalIcon,
  TextIcon,
  FilePlusIcon,
  SearchIcon,
  FolderSearchIcon,
  SparklesIcon,
  Trash2Icon,
  FilePenIcon,
} from "lucide-react";

import {
  AgentActivity,
  AgentActivityContent,
  AgentActivityHeader,
  AgentActivityStep,
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
import { useElapsedMs } from "../hooks/use-elapsed-ms";
import { useTouchPrimary } from "../hooks/use-touch-primary";
import { cn } from "../lib/utils";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "./message";
import {
  formatDuration,
  getRowApproval,
  getRowStatus,
  getRowSummary,
  getToolDurationMs,
  summarizeTurnRows,
} from "./tool-step";
import type { StepRow } from "./tool-step";

type AssistantMessageProps = {
  turn: AgentAssistantTurn<AgentToolSet>;
  onFork?: (messageId: string) => void;
  /**
   * Answers a call the turn was held on. The turn is not re-run here: the caller
   * resumes it with the answer, and the resumed stream is what moves the step
   * on. Only the approval id is named — the step and the call it belongs to are
   * the caller's to look up in the transcript.
   */
  onRespondToolApproval?: (approvalId: string, approved: boolean) => void;
};

/** Max characters of the first line used as a Frame title. */
const REASON_TOOL_LABEL_MAX_LENGTH = 180;

/**
 * Share of the screen one Frame in a step may take. A Frame holds its own
 * scroll, so a long tool output or a streaming answer fills this much of the
 * screen and then scrolls inside itself instead of growing the dialog.
 */
const STEP_FRAME_MAX_HEIGHT = "50vh";

/**
 * The copy controls every Frame panel shares. Declared once so the eight tool
 * branches below state only what differs about them.
 */
const FRAME_CONTROLS = {
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
} as const;

const getPureTextLabel = (text: string | undefined, fallback: string) => {
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

const getStepLabel = (action: string, detail?: string) => {
  if (detail) {
    return (
      <>
        <span className="text-foreground font-medium">{action}</span>
        <span className="ml-1 truncate">{detail}</span>
      </>
    );
  }

  return <span className="text-foreground font-medium">{action}</span>;
};

/**
 * The replaced and replacement text of an edit, as `-`/`+` prefixed lines so
 * the step reads like a diff. With `replace_all` the same text may have been
 * replaced several times; the step's output line reports how many.
 */
const editDiffLines = (oldString: string, newString: string) => [
  ...oldString.split("\n").map((text) => ({ sign: "-" as const, text })),
  ...newString.split("\n").map((text) => ({ sign: "+" as const, text })),
];

/**
 * Splits a turn into the steps that led to its answer and the answer itself.
 *
 * Each step's parts are kept paired with the step that holds them: the step is
 * where the timing lives, so a row flattened away from its owner could not say
 * how long it took.
 */
const splitAssistantMessageSteps = (turn: AgentAssistantTurn<AgentToolSet>) => {
  const stepRows: StepRow[] = turn.content.flatMap((step) =>
    step.content.map((part) => ({
      part: part as AgentPart<AgentToolSet>,
      step,
    }))
  );

  const answerRowIndex =
    stepRows.at(-1)?.part.type === "text" ? stepRows.length - 1 : -1;
  const answerPart =
    answerRowIndex === -1
      ? undefined
      : (stepRows[answerRowIndex]?.part as AgentTextPart | undefined);
  return {
    // A turn with no text at all — one still running, or one that failed
    // mid-tool — has no answer to hold back, so every row is a step. Slicing to
    // a `-1` index would silently drop the last of them.
    stepRows:
      answerRowIndex === -1 ? stepRows : stepRows.slice(0, answerRowIndex),
    answerPart,
  };
};

/**
 * The turn's elapsed time, kept in its own component so the once-a-second tick
 * re-renders this span and nothing else. Holding the clock in `AssistantMessage`
 * would re-render every step row on every tick, and `AgentActivityStep`'s memo
 * would not stop it — its children are fresh elements each time.
 */
const TurnElapsed = ({ turn }: { turn: AgentAssistantTurn<AgentToolSet> }) => {
  const running = turn.status === "streaming";
  const elapsedMs = useElapsedMs({
    startedAt: turn.createdAt,
    endedAt: turn.completedAt,
    running,
  });

  // The tick lands wherever it lands within the second, so floor it: a timer
  // reading `3.4s` and then `4.4s` looks broken next to one that counts
  // seconds.
  return (
    <span>
      {formatDuration(
        running ? Math.floor(elapsedMs / 1000) * 1000 : elapsedMs
      )}
    </span>
  );
};

const TURN_HEADING = {
  streaming: "Working",
  done: "Finished",
  // A turn whose calls were held for approval: the model is not working, and
  // it is not finished either — the user is what it is waiting on.
  wait_review: "Awaiting review",
  aborted: "Stopped",
  error: "Failed",
} as const;

const renderToolError = (part: AgentPart<AgentToolSet>) => {
  if (!isAgentToolPart(part)) {
    return;
  }

  return (
    part.state === "output-error" &&
    part.errorText && (
      <>
        <div className="flex justify-between items-center pl-4 pr-1 mb-1">
          <div className="text-muted-foreground">ERROR</div>
          <div>
            <CopyButton
              className="text-muted-foreground"
              size="icon-sm"
              variant="ghost"
              label="Copy"
              message={part.errorText ?? ""}
            />
          </div>
        </div>
        <FramePanel>
          <div className="whitespace-pre">{part.errorText ?? ""}</div>
        </FramePanel>
      </>
    )
  );
};

export const AssistantMessage = ({
  turn,
  onFork,
  onRespondToolApproval,
}: AssistantMessageProps) => {
  if (turn.type !== "assistant") {
    return null;
  }

  const isTouch = useTouchPrimary();
  const isRunning = turn.status === "streaming";

  const { answerPart, stepRows } = splitAssistantMessageSteps(turn);

  return (
    <div className="flex flex-col gap-4 group">
      <AgentActivity defaultExpanded={new Set(["root"])}>
        <AgentActivityHeader
          path="root"
          loading={isRunning}
          summary={summarizeTurnRows(stepRows)}
          duration={<TurnElapsed turn={turn} />}
        >
          {TURN_HEADING[turn.status]}
        </AgentActivityHeader>
        <AgentActivityContent path="root">
          {stepRows.map(({ part, step }, i) => {
            const status = getRowStatus(part);
            const summary = getRowSummary(part);
            const durationMs = getToolDurationMs(part, step);
            const duration =
              durationMs === undefined ? undefined : formatDuration(durationMs);
            const approval = getRowApproval(part);
            const respondApproval =
              approval && onRespondToolApproval
                ? (approvalId: string, approved: boolean) =>
                    onRespondToolApproval(approvalId, approved)
                : undefined;

            if (part.type === "text") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={TextIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Note", getPureTextLabel(part.text, ""))}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Note</FrameTitle>
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
                      <MessageResponse controls={FRAME_CONTROLS}>
                        {part.text}
                      </MessageResponse>
                    </FramePanel>
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "reasoning") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={BrainIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel(
                    "Reasoning",
                    getPureTextLabel(part.text, "")
                  )}
                  status={status}
                  summary={summary}
                  duration={duration}
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
                      <MessageResponse controls={FRAME_CONTROLS}>
                        {part.text}
                      </MessageResponse>
                    </FramePanel>
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-read-file") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={EyeIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Read", part.input?.path)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Read</FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-write-file") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={FilePlusIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Create", part.input?.path)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Create</FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-delete-file") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={Trash2Icon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Delete", part.input?.path)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Delete</FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-edit-file") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={FilePenIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Edit", part.input?.path)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Edit</FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">DIFF</div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre-wrap wrap-break-word font-mono text-xs">
                        {editDiffLines(
                          part.input?.old_string ?? "",
                          part.input?.new_string ?? ""
                        ).map((line, j) => (
                          <div
                            key={j}
                            className={
                              line.sign === "-"
                                ? "text-destructive"
                                : "text-green-600"
                            }
                          >
                            {line.sign}
                            {line.text}
                          </div>
                        ))}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-grep") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={SearchIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Grep", part.input?.pattern)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Grep</FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-glob") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={FolderSearchIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Glob", part.input?.pattern)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Glob</FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-web-fetch") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={GlobeIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Fetch", part.input?.url)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Fetch</FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-load-skill") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={SparklesIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Load skill", part.input?.skill)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>Load skill {part.input?.skill}</FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <MessageResponse controls={FRAME_CONTROLS}>
                        {part.output?.output ?? ""}
                      </MessageResponse>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            } else if (part.type === "tool-bash") {
              return (
                <AgentActivityStep
                  key={i}
                  path={`${i}`}
                  icon={SquareTerminalIcon}
                  approval={approval}
                  onRespondApproval={respondApproval}
                  label={getStepLabel("Bash", part.input?.description)}
                  status={status}
                  summary={summary}
                  duration={duration}
                >
                  <Frame
                    variant="default"
                    maxHeight={STEP_FRAME_MAX_HEIGHT}
                    overflowBehavior="scroll"
                  >
                    <FrameHeader>
                      <FrameTitle>
                        {getStepLabel("Bash", part.input?.description)}
                      </FrameTitle>
                    </FrameHeader>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">INPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={JSON.stringify(part.input, null, 2) ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {JSON.stringify(part.input, null, 2) ?? ""}
                      </div>
                    </FramePanel>
                    <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                      <div className="text-muted-foreground">OUTPUT</div>
                      <div>
                        <CopyButton
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          label="Copy"
                          message={part.output?.output ?? ""}
                        />
                      </div>
                    </div>
                    <FramePanel>
                      <div className="whitespace-pre">
                        {part.output?.output ?? ""}
                      </div>
                    </FramePanel>
                    {renderToolError(part)}
                  </Frame>
                </AgentActivityStep>
              );
            }
            return null;
          })}
        </AgentActivityContent>
      </AgentActivity>
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
