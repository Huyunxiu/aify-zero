import type { AgentToolSet } from "@workspace/agent";
import { isAgentToolPart } from "@workspace/agent-client";
import type {
  AgentAssistantTurn,
  AgentPart,
  AgentTextPart,
  AgentToolPart,
} from "@workspace/agent-client";
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
} from "lucide-react";

import {
  AgentActivity,
  AgentActivityApproval,
  AgentActivityContent,
  AgentActivityHeader,
  AgentActivityStep,
} from "../components/ai-elements/chain-of-turn";
import type { ToolApprovalAnswer } from "../components/ai-elements/chain-of-turn";
import { Button } from "../components/button";
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
import {
  formatDuration,
  getPartDurationMs,
  getPartStatus,
  getPartSummary,
  summarizeTurn,
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

/** 把一个替换块摊平成 `-`/`+` 行，让步骤读起来像 diff。 */
const editDiffLines = (oldString: string, newString: string) => [
  ...oldString.split("\n").map((text) => ({ sign: "-" as const, text })),
  ...newString.split("\n").map((text) => ({ sign: "+" as const, text })),
];

/**
 * 解析工具返回的展示用 diff 行，格式为 `+ 12 content`。
 * 首字符是标记，其余部分（行号 + 内容）原样展示。
 */
const parseRenderedDiffLine = (line: string) => ({
  sign: line[0] ?? " ",
  text: line.slice(1),
});

/**
 * Splits a turn into the steps that led to its answer and the answer itself.
 *
 * Each step's parts are kept paired with the step that holds them: the step is
 * where the timing lives, so a row flattened away from its owner could not say
 * how long it took.
 */
const splitAssistantMessageSteps = (turn: AgentAssistantTurn<AgentToolSet>) => {
  const parts: StepRow[] = turn.content.flatMap((step) =>
    step.content.map((part) => ({
      part: part as AgentPart<AgentToolSet>,
      step,
    }))
  );

  const answerPartIndex =
    parts.at(-1)?.part.type === "text" ? parts.length - 1 : -1;
  const answerPart =
    answerPartIndex === -1
      ? undefined
      : (parts[answerPartIndex]?.part as AgentTextPart | undefined);
  return {
    // A turn with no text at all — one still running, or one that failed
    // mid-tool — has no answer to hold back, so every row is a step. Slicing to
    // a `-1` index would silently drop the last of them.
    parts: answerPartIndex === -1 ? parts : parts.slice(0, answerPartIndex),
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

  const { answerPart, parts } = splitAssistantMessageSteps(turn);

  const getInlineToolApprovalComponent = (part: AgentToolPart) => {
    if (!part.approval) {
      return;
    }

    return (
      <FramePanel className="rounded-t-none -mt-1 px-2.5 py-2.5">
        <div className="flex items-center gap-2">
          <Button
            variant={part.approval.approved === true ? "success" : "default"}
            onClick={() => onRespondToolApproval?.(part.approval!.id, true)}
            size="sm"
          >
            {part.approval.approved ? "Approved" : "Approve"}
          </Button>
          {part.approval.approved === undefined && (
            <Button
              onClick={() => onRespondToolApproval?.(part.approval!.id, false)}
              size="sm"
              variant="outline"
            >
              Deny
            </Button>
          )}
        </div>
      </FramePanel>
    );
  };

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
            {parts.map(({ part, step }, i) => {
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
                  <AgentActivityStep
                    key={i}
                    path={`${i}`}
                    icon={Minimize2Icon}
                    label={getStepLabel("Compact", trigger)}
                    status={status}
                    summary={tokens || summary}
                    duration={duration}
                  >
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
                  </AgentActivityStep>
                );
              }

              if (part.type === "text") {
                return (
                  <AgentActivityStep
                    key={i}
                    path={`${i}`}
                    icon={TextIcon}
                    label={getStepLabel(
                      "Note",
                      getPureTextLabel(part.text, "")
                    )}
                    status={status}
                    summary={summary}
                    duration={duration}
                  >
                    <Frame variant="default" overflowBehavior="scroll">
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
                    label={getStepLabel(
                      "Reasoning",
                      getPureTextLabel(part.text, "")
                    )}
                    status={status}
                    summary={summary}
                    duration={duration}
                  >
                    <Frame variant="default" overflowBehavior="scroll">
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
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={EyeIcon}
                      label={getStepLabel("Read", part.input?.path)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

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
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-write-file") {
                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={FilePlusIcon}
                      label={getStepLabel("Create", part.input?.path)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

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
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-delete-file") {
                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={Trash2Icon}
                      label={getStepLabel("Delete", part.input?.path)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

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
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-edit-file") {
                // 执行完成后展示工具实际写入的 diff；流式输出期间 output 还不存在，
                // 退回用请求参数拼出的预览。
                const actualDiff = part.output?.metadata?.diff;
                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={FilePenIcon}
                      label={getStepLabel("Edit", part.input?.path)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

                        <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                          <div className="text-muted-foreground">DIFF</div>
                        </div>
                        <FramePanel>
                          <div className="whitespace-pre-wrap wrap-break-word font-mono text-xs">
                            {actualDiff
                              ? actualDiff.split("\n").map((line, j) => {
                                  const { sign, text } =
                                    parseRenderedDiffLine(line);
                                  return (
                                    <div
                                      key={j}
                                      className={
                                        sign === "-"
                                          ? "text-destructive"
                                          : sign === "+"
                                            ? "text-green-600"
                                            : "text-muted-foreground"
                                      }
                                    >
                                      {sign}
                                      {text}
                                    </div>
                                  );
                                })
                              : (part.input?.edits ?? []).map(
                                  (block, blockIndex) => {
                                    // 流式输出期间 input 是 DeepPartial，
                                    // 未拼完整的编辑块先不渲染。
                                    if (
                                      typeof block?.oldText !== "string" ||
                                      typeof block?.newText !== "string"
                                    ) {
                                      return null;
                                    }
                                    return (
                                      <div
                                        key={blockIndex}
                                        className={
                                          blockIndex > 0 ? "mt-2" : undefined
                                        }
                                      >
                                        {editDiffLines(
                                          block.oldText,
                                          block.newText
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
                                    );
                                  }
                                )}
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
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-grep") {
                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={SearchIcon}
                      label={getStepLabel("Grep", part.input?.pattern)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

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
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-glob") {
                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={FolderSearchIcon}
                      label={getStepLabel("Glob", part.input?.pattern)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

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
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-web-fetch") {
                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={GlobeIcon}
                      label={getStepLabel("Fetch", part.input?.url)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

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
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-load-skill") {
                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={SparklesIcon}
                      label={getStepLabel("Load skill", part.input?.skill)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
                        <FrameHeader>
                          <FrameTitle>
                            Load skill {part.input?.skill}
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

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
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={SquareTerminalIcon}
                      label={getStepLabel(shellAction, part.input?.description)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
                        <FrameHeader>
                          <FrameTitle>
                            {getStepLabel(shellAction, part.input?.description)}
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

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
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={BotIcon}
                      label={getStepLabel("Task", part.input?.description)}
                      status={status}
                      summary={summary}
                      duration={duration}
                      selected={selectedSubagentSessionId === subagentSessionId}
                      onSelect={() => selectSubagent(subagentSessionId)}
                    />
                  );
                }

                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={BotIcon}
                      label={getStepLabel("Task", part.input?.description)}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <Frame variant="default" overflowBehavior="scroll">
                        <FrameHeader>
                          <FrameTitle>
                            {getStepLabel("Task", part.input?.description)}
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
                              message={
                                JSON.stringify(part.input, null, 2) ?? ""
                              }
                            />
                          </div>
                        </div>
                        <FramePanel
                          className={cn({ "rounded-b-none": part.approval })}
                        >
                          <div className="whitespace-pre">
                            {JSON.stringify(part.input, null, 2) ?? ""}
                          </div>
                        </FramePanel>
                        {getInlineToolApprovalComponent(part)}

                        {showResult && (
                          <>
                            <div className="flex justify-between items-center pl-4 pr-1 mb-1">
                              <div className="text-muted-foreground">
                                OUTPUT
                              </div>
                              <div>
                                <CopyButton
                                  className="text-muted-foreground"
                                  size="icon-sm"
                                  variant="ghost"
                                  label="Copy"
                                  message={result}
                                />
                              </div>
                            </div>
                            <FramePanel>
                              <MessageResponse controls={FRAME_CONTROLS}>
                                {result}
                              </MessageResponse>
                            </FramePanel>
                          </>
                        )}
                        {renderToolError(part)}
                      </Frame>
                    </AgentActivityStep>
                    <AgentActivityApproval
                      part={part}
                      onRespondToolApproval={onRespondToolApproval}
                    />
                  </>
                );
              } else if (part.type === "tool-questionnaire") {
                return (
                  <>
                    <AgentActivityStep
                      key={i}
                      path={`${i}`}
                      icon={ListChecksIcon}
                      label={getStepLabel(
                        "Questionnaire",
                        part.input?.title ?? part.input?.questions?.[0]?.prompt
                      )}
                      status={status}
                      summary={summary}
                      duration={duration}
                    >
                      <QuestionnaireSummary part={part} />
                      {renderToolError(part)}
                    </AgentActivityStep>
                    {questionnairePlacement === "inline" && (
                      <QuestionnaireCard
                        part={part}
                        onRespond={onRespondToolApproval}
                      />
                    )}
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
