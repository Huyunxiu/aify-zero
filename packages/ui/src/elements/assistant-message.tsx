import { isAgentToolPart } from "@workspace/agent-client";
import type { AgentToolSet, AgentAssistantTurn } from "@workspace/agent-client";
import {
  BotIcon,
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
  ListChecksIcon,
  Minimize2Icon,
  RotateCwIcon,
  WrenchIcon,
} from "lucide-react";

import {
  AgentActivity,
  AgentActivityApproval,
  AgentActivityContent,
  AgentActivityHeader,
  AgentStep,
  AgentStepButton,
  AgentStepContent,
  AgentStepDescription,
  AgentStepIcon,
  AgentStepRow,
  AgentStepTitle,
  AgentStepTrigger,
} from "../components/ai-elements/chain-of-turn";
import type { ToolApprovalAnswer } from "../components/ai-elements/chain-of-turn";
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
import { useSubagentPane } from "../stores/subagent-pane";
import { splitAssistantMessageSteps } from "./assistant-entries";
import { formatTokens } from "./compaction-message";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "./message";
import { AssistantAvatar } from "./message-avatar";
import { QuestionnaireCard, QuestionnaireSummary } from "./questionnaire";
import type { QuestionnairePlacement } from "./questionnaire";
import { SteeringStep } from "./steering-step";
import {
  editDiffRows,
  editDiffText,
  ToolPanels,
  ToolPartError,
  ToolRenderedSection,
  ToolSection,
} from "./tool-panels";
import {
  formatDuration,
  getDisplayedToolName,
  getPartDurationMs,
  getPartStatus,
  getPartSummary,
  summarizeTurn,
} from "./tool-step";

type AssistantMessageProps = {
  turn: AgentAssistantTurn<AgentToolSet>;
  onFork?: (messageId: string) => void;
  /**
   * Answers a call the turn was held on. The turn is not re-run here: the caller
   * resumes it with the answer, and the resumed stream is what moves the step
   * on. Only the approval id is named — the step and the call it belongs to are
   * the caller's to look up in the transcript.
   */
  onRespondToolApproval?: (
    approvalId: string,
    approved: boolean,
    answer?: ToolApprovalAnswer
  ) => void;
  /**
   * Where a held questionnaire draws its form. `"inline"` — the default for a
   * transcript rendered on its own — keeps it beside the call that asked;
   * `"composer"` leaves it to the page, which draws it in the prompt input's
   * place and passes this back as something other than `"inline"`.
   */
  questionnairePlacement?: QuestionnairePlacement;
};

/** Max characters of the first line used as a Frame title. */
const REASON_TOOL_LABEL_MAX_LENGTH = 180;

/**
 * The copy controls every rendered Markdown body shares. Declared once so each
 * branch below states only what differs about it.
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
 * The turn's elapsed time, kept in its own component so the once-a-second tick
 * re-renders this span and nothing else. Holding the clock in `AssistantMessage`
 * would re-render every step row on every tick.
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

/**
 * 压缩是怎么触发的，写在行尾和展开后的标题旁。
 *
 * 文案与 `compaction.trigger.*` 一致；本组件的行标签都是英文硬编码的，所以
 * 不为这一行单独走 i18n，免得同一串行一半中文一半英文。
 */
const COMPACTION_TRIGGER_LABEL = {
  pressure: "automatic",
  manual: "manual",
  overflow: "overflow recovery",
} as const;

const TURN_HEADING = {
  streaming: "Working",
  done: "Finished",
  // A turn whose calls were held for approval: the model is not working, and
  // it is not finished either — the user is what it is waiting on.
  wait_review: "Awaiting review",
  aborted: "Stopped",
  error: "Failed",
} as const;

export const AssistantMessage = ({
  turn,
  onFork,
  onRespondToolApproval,
  questionnairePlacement = "inline",
}: AssistantMessageProps) => {
  if (turn.type !== "assistant") {
    return null;
  }

  const isTouch = useTouchPrimary();
  const isRunning = turn.status === "streaming";

  // The subagent the pane beside this session is showing, and how to point it
  // at another. Read here rather than in the row: the rows are drawn in a map,
  // and this is a component.
  const selectedSubagentSessionId = useSubagentPane((state) => state.sessionId);
  const selectSubagent = useSubagentPane((state) => state.select);

  const { answerPart, entries, parts } = splitAssistantMessageSteps(turn);

  return (
    <div className="group flex w-full items-start gap-3 pr-8">
      <AssistantAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <AgentActivity defaultExpanded={new Set(["root"])}>
          <AgentActivityHeader
            path="root"
            loading={isRunning}
            summary={summarizeTurn(parts)}
            duration={<TurnElapsed turn={turn} />}
          >
            {TURN_HEADING[turn.status]}
          </AgentActivityHeader>
          <AgentActivityContent path="root">
            {entries.map((entry, i) => {
              if (entry.kind === "steering") {
                return <SteeringStep key={entry.step.id} step={entry.step} />;
              }

              const { part, step } = entry;
              const status = getPartStatus(part, turn.status);
              const summary = getPartSummary(part);
              const durationMs = getPartDurationMs(part, step);
              const duration =
                durationMs === undefined
                  ? undefined
                  : formatDuration(durationMs);

              if (part.type === "compaction") {
                // 内联压缩只是这一轮里的一步：和相邻的 note、工具调用一样，
                // 收成一行、点开才看摘要。独立的压缩 turn（手工）仍然用
                // CompactionMessage —— 那一轮本身就是一张概述式的 Frame。
                const { record } = part;
                const trigger = record
                  ? COMPACTION_TRIGGER_LABEL[record.trigger]
                  : undefined;
                const tokens =
                  record &&
                  `${formatTokens(record.tokensBefore)} → ${formatTokens(record.tokensAfter)} tokens`;

                return (
                  <AgentStep key={i}>
                    <AgentStepTrigger>
                      <AgentStepRow status={status} duration={duration}>
                        <AgentStepIcon>
                          <Minimize2Icon />
                        </AgentStepIcon>
                        <AgentStepTitle>
                          {getStepLabel("Compact", trigger)}
                        </AgentStepTitle>
                        {(tokens || summary) && (
                          <AgentStepDescription>
                            {tokens || summary}
                          </AgentStepDescription>
                        )}
                      </AgentStepRow>
                    </AgentStepTrigger>
                    <AgentStepContent>
                      <Frame variant="default" overflowBehavior="scroll">
                        <FrameHeader>
                          <FrameTitle>
                            Compact
                            {trigger && (
                              <span className="ml-2 font-normal text-muted-foreground text-xs">
                                {trigger}
                              </span>
                            )}
                          </FrameTitle>
                          {tokens && (
                            <span className="text-muted-foreground text-xs">
                              {tokens}
                            </span>
                          )}
                        </FrameHeader>
                        <FramePanel>
                          <MessageResponse controls={FRAME_CONTROLS}>
                            {record?.summary ?? ""}
                          </MessageResponse>
                        </FramePanel>
                      </Frame>
                    </AgentStepContent>
                  </AgentStep>
                );
              }

              if (part.type === "retry") {
                // 一次重试已经发生：失败的那一步没有留下记录，留下来的是
                // 这一次。它跟着答复一起进历史，答案慢了才有解释。
                return (
                  <AgentStep key={i}>
                    <AgentStepTrigger>
                      <AgentStepRow status={status} duration={duration}>
                        <AgentStepIcon>
                          <RotateCwIcon />
                        </AgentStepIcon>
                        <AgentStepTitle>
                          {getStepLabel(
                            "Retry",
                            `${part.index}/${part.maxRetries}`
                          )}
                        </AgentStepTitle>
                        {part.reason && (
                          <AgentStepDescription>
                            {part.reason}
                          </AgentStepDescription>
                        )}
                      </AgentStepRow>
                    </AgentStepTrigger>
                    <AgentStepContent>
                      <Frame variant="default" overflowBehavior="scroll">
                        <FramePanel>
                          <MessageResponse controls={FRAME_CONTROLS}>
                            {part.reason}
                          </MessageResponse>
                        </FramePanel>
                      </Frame>
                    </AgentStepContent>
                  </AgentStep>
                );
              }

              if (part.type === "text") {
                return (
                  <AgentStep key={i}>
                    <AgentStepTrigger>
                      <AgentStepRow status={status} duration={duration}>
                        <AgentStepIcon>
                          <TextIcon />
                        </AgentStepIcon>
                        <AgentStepTitle>
                          {getStepLabel(
                            "Note",
                            getPureTextLabel(part.text, "")
                          )}
                        </AgentStepTitle>
                        {summary && (
                          <AgentStepDescription>{summary}</AgentStepDescription>
                        )}
                      </AgentStepRow>
                    </AgentStepTrigger>
                    <AgentStepContent>
                      <ToolRenderedSection copyValue={part.text} label="Note">
                        <MessageResponse controls={FRAME_CONTROLS}>
                          {part.text}
                        </MessageResponse>
                      </ToolRenderedSection>
                    </AgentStepContent>
                  </AgentStep>
                );
              } else if (part.type === "reasoning") {
                return (
                  <AgentStep key={i}>
                    <AgentStepTrigger>
                      <AgentStepRow status={status} duration={duration}>
                        <AgentStepIcon>
                          <BrainIcon />
                        </AgentStepIcon>
                        <AgentStepTitle>
                          {getStepLabel(
                            "Reasoning",
                            getPureTextLabel(part.text, "")
                          )}
                        </AgentStepTitle>
                        {summary && (
                          <AgentStepDescription>{summary}</AgentStepDescription>
                        )}
                      </AgentStepRow>
                    </AgentStepTrigger>
                    <AgentStepContent>
                      <ToolRenderedSection
                        copyValue={part.text}
                        label="Reasoning"
                      >
                        <MessageResponse controls={FRAME_CONTROLS}>
                          {part.text}
                        </MessageResponse>
                      </ToolRenderedSection>
                    </AgentStepContent>
                  </AgentStep>
                );
              } else if (part.type === "tool-read-file") {
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <EyeIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Read", part.input?.path)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>Read</FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-write-file") {
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <FilePlusIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Create", part.input?.path)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>Create</FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-delete-file") {
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <Trash2Icon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Delete", part.input?.path)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>Delete</FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-edit-file") {
                // 执行完成后展示工具实际写入的 diff；流式输出期间 output 还不存在，
                // 退回用请求参数拼出的预览。
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <FilePenIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Edit", part.input?.path)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>Edit</FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          >
                            <ToolRenderedSection
                              copyValue={editDiffText(part)}
                              label="Diff"
                            >
                              <div className="wrap-break-word font-mono text-xs whitespace-pre-wrap">
                                {editDiffRows(part).map((row, j) => (
                                  <div
                                    key={j}
                                    className={
                                      row.sign === "-"
                                        ? "text-destructive"
                                        : row.sign === "+"
                                          ? "text-green-600"
                                          : "text-muted-foreground"
                                    }
                                  >
                                    {row.sign}
                                    {row.text}
                                  </div>
                                ))}
                              </div>
                            </ToolRenderedSection>
                          </ToolPanels>
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-grep") {
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <SearchIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Grep", part.input?.pattern)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>Grep</FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-glob") {
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <FolderSearchIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Glob", part.input?.pattern)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>Glob</FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-web-fetch") {
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <GlobeIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Fetch", part.input?.url)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>Fetch</FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-load-skill") {
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <SparklesIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Load skill", part.input?.skill)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>
                              Load skill {part.input?.skill}
                            </FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                            renderOutput={(text) => (
                              <MessageResponse controls={FRAME_CONTROLS}>
                                {text}
                              </MessageResponse>
                            )}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (
                part.type === "tool-bash" ||
                part.type === "tool-powershell"
              ) {
                const shellAction =
                  part.type === "tool-powershell" ? "PowerShell" : "Bash";
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <SquareTerminalIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel(shellAction, part.input?.description)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>
                              {getStepLabel(
                                shellAction,
                                part.input?.description
                              )}
                            </FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-task") {
                const result = part.output?.output ?? "";
                const subagentSessionId = part.output?.metadata?.sessionId;
                // A call that failed before it made a subagent answers with the
                // reason and nothing else; one that failed outright has no answer
                // at all, and an empty panel under INPUT is worse than none.
                const showResult = result.length > 0;

                // A call that started a subagent is read in the pane beside this
                // session, not in a dialog over it — the transcript is the thing
                // to see, and it is far too long to sit in a dialog. A call that
                // never got that far has only its own answer to show, and the
                // dialog is where that answer is readable.
                if (subagentSessionId) {
                  return (
                    <AgentStepButton
                      key={i}
                      selected={selectedSubagentSessionId === subagentSessionId}
                      onClick={() => selectSubagent(subagentSessionId)}
                    >
                      <AgentStepRow status={status} duration={duration}>
                        <AgentStepIcon>
                          <BotIcon />
                        </AgentStepIcon>
                        <AgentStepTitle>
                          {getStepLabel("Task", part.input?.description)}
                        </AgentStepTitle>
                        {summary && (
                          <AgentStepDescription>{summary}</AgentStepDescription>
                        )}
                      </AgentStepRow>
                    </AgentStepButton>
                  );
                }

                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <BotIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel("Task", part.input?.description)}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>
                              {getStepLabel("Task", part.input?.description)}
                            </FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                            hideOutput={!showResult}
                            renderOutput={(text) => (
                              <MessageResponse controls={FRAME_CONTROLS}>
                                {text}
                              </MessageResponse>
                            )}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-questionnaire") {
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <ListChecksIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel(
                              "Questionnaire",
                              part.input?.title ??
                                part.input?.questions?.[0]?.prompt
                            )}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <QuestionnaireSummary part={part} />
                        <ToolPartError part={part} />
                      </AgentStepContent>
                    </AgentStep>
                    {questionnairePlacement === "inline" && (
                      <QuestionnaireCard
                        part={part}
                        onRespond={onRespondToolApproval}
                      />
                    )}
                  </>
                );
              } else if (
                part.type === "tool-job-output" ||
                part.type === "tool-job-list" ||
                part.type === "tool-job-kill"
              ) {
                const target =
                  part.type === "tool-job-list" ? undefined : part.input?.jobId;
                const label =
                  part.type === "tool-job-list"
                    ? "Background jobs"
                    : `${part.type === "tool-job-kill" ? "Kill job" : "Read job"} ${target ?? ""}`;
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <ListChecksIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>{label}</AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <div className="flex flex-col gap-1.5 p-1.5">
                            <ToolSection
                              label="Output"
                              language="text"
                              value={part.output?.output ?? ""}
                            />
                            <ToolPartError part={part} />
                          </div>
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (isAgentToolPart(part)) {
                // 兜底分支：没有专属渲染的工具都走这里。MCP 工具的渲染因此
                // 不需要逐个写，新加的内置工具也不会在面板里消失。
                // 转调的调用按它实际调用的工具显示，见 getDisplayedToolName。
                const toolName = getDisplayedToolName(part);
                const separator = toolName.indexOf("__");
                const serverName =
                  separator > 0 ? toolName.slice(0, separator) : undefined;
                const shortName =
                  separator > 0 ? toolName.slice(separator + 2) : toolName;
                return (
                  <>
                    <AgentStep key={i}>
                      <AgentStepTrigger>
                        <AgentStepRow status={status} duration={duration}>
                          <AgentStepIcon>
                            <WrenchIcon />
                          </AgentStepIcon>
                          <AgentStepTitle>
                            {getStepLabel(
                              serverName
                                ? `${serverName} · ${shortName}`
                                : shortName
                            )}
                          </AgentStepTitle>
                          {summary && (
                            <AgentStepDescription>
                              {summary}
                            </AgentStepDescription>
                          )}
                        </AgentStepRow>
                      </AgentStepTrigger>
                      <AgentStepContent>
                        <Frame
                          className="bg-transparent shadow-none"
                          variant="default"
                          overflowBehavior="scroll"
                        >
                          <FrameHeader className="px-3">
                            <FrameTitle>
                              {serverName
                                ? `${serverName} · ${shortName}`
                                : shortName}
                            </FrameTitle>
                          </FrameHeader>
                          <ToolPanels
                            part={part}
                            onRespond={onRespondToolApproval}
                          />
                        </Frame>
                      </AgentStepContent>
                    </AgentStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
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
    </div>
  );
};
