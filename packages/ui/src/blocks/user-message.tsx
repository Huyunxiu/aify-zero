import type {
  AgentUserPart,
  AgentUserTurn,
  StepSource,
} from "@workspace/agent-client";
import {
  isAgentFilePart,
  isAgentTextPart,
  JOB_NOTICE_STEP_SOURCE,
  SUBAGENT_NOTICE_STEP_SOURCE,
  TIMER_STEP_SOURCE,
} from "@workspace/agent-client";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "../blocks/attachments";
import { CopyButton } from "../components/copy-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip";
import { useTouchPrimary } from "../hooks/use-touch-primary";
import { cn } from "../lib/utils";
import { Message, MessageActions, MessageContent } from "./message";
import { UserAvatar } from "./message-avatar";
import { renderTextToReactElement } from "./prompt-input-tiptap";

/** 用户侧 parts 的纯文本；复制按钮和渲染都用同一份。 */
export const getUserMessageText = (parts: AgentUserPart[]): string =>
  parts
    .filter(isAgentTextPart)
    .map((part) => part.text)
    .join("\n\n");

/**
 * 用户消息的附件。
 *
 * 顶层用户消息和 assistant turn 里的 steering step 共用它；`onRemove` 不传，
 * 历史消息里的附件因此不显示删除按钮。
 */
export const UserMessageAttachments = ({
  parts,
}: {
  parts: AgentUserPart[];
}) => {
  const files = parts.filter(isAgentFilePart).map((file) => ({
    filename: file.filename,
    id: nanoid(),
    mediaType: file.mediaType,
    type: file.type,
    url: file.url,
  }));

  if (files.length === 0) {
    return null;
  }

  return (
    <Attachments
      className="flex items-start flex-wrap gap-2 ml-auto w-fit"
      variant="grid"
    >
      {files.map((file, i) => (
        <Attachment
          data={file}
          key={`${file.type}-${file.mediaType}-${file.filename}-${i}`}
        >
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
};

/** 用户消息的正文；空文本不渲染外壳。 */
export const UserMessageText = ({ parts }: { parts: AgentUserPart[] }) => {
  const text = getUserMessageText(parts);

  if (text.length === 0) {
    return null;
  }

  return (
    <div className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      {renderTextToReactElement(text)}
    </div>
  );
};

/** 系统消息的标题键；每加一种来源，这里多一项。 */
export type SystemNoticeLabelKey =
  | "jobNotice.marker"
  | "subagentNotice.marker"
  | "timerNotice.marker";

/**
 * 一条不是用户说的消息，按来源取标题。
 *
 * 完成通知和定时器到点都走这条：它们都可能是收件箱里的一行，也都不该画成
 * 用户气泡。
 * @param source - step 上的来源标记。
 * @returns i18n 键；用户自己说的话返回 undefined。
 */
export const systemNoticeLabelKey = (
  source: StepSource | undefined
): SystemNoticeLabelKey | undefined => {
  if (source === JOB_NOTICE_STEP_SOURCE) {
    return "jobNotice.marker";
  }
  if (source === SUBAGENT_NOTICE_STEP_SOURCE) {
    return "subagentNotice.marker";
  }
  if (source === TIMER_STEP_SOURCE) {
    return "timerNotice.marker";
  }
  return undefined;
};

/** 系统消息的展示：它不是用户说的话，不画用户气泡。 */
export const SystemNotice = ({
  label,
  parts,
}: {
  label: string;
  parts: AgentUserPart[];
}) => (
  <div aria-label={label} className="w-full py-1" role="note">
    <div className="rounded-xl border bg-muted/40 px-3 py-2">
      <div className="mb-1 font-medium text-muted-foreground text-xs">
        {label}
      </div>
      <UserMessageText parts={parts} />
    </div>
  </div>
);

type UserMessageProps = {
  turn: AgentUserTurn;
  onFork?: (messageId: string) => void;
};

export const UserMessage = ({ turn }: UserMessageProps) => {
  const { t } = useTranslation();
  const isTouch = useTouchPrimary();
  // A user turn wraps exactly one user step, so flattening gives back the flat
  // part list the rendering below was written against.
  const parts: AgentUserPart[] = turn.content.flatMap((step) => step.content);
  const text = getUserMessageText(parts);
  const noticeKey = turn.content
    .map((step) => systemNoticeLabelKey(step.source))
    .find((key) => key !== undefined);

  // 完成通知和定时器到点都不是用户说的话：不画用户气泡，也不给复制与重新生成
  // 的动作。
  if (noticeKey !== undefined) {
    return <SystemNotice label={t(noticeKey)} parts={parts} />;
  }

  return (
    <Message avatar={<UserAvatar />} from="user" className="group">
      <UserMessageAttachments parts={parts} />
      <MessageContent>
        <UserMessageText parts={parts} />
      </MessageContent>
      {text.length > 0 && (
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
                  message={text}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p>Copy to clipboard</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </MessageActions>
      )}
    </Message>
  );
};
