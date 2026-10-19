import type { AgentUserPart, AgentUserTurn } from "@workspace/agent-client";
import { isAgentFilePart, isAgentTextPart } from "@workspace/agent-client";
import { nanoid } from "nanoid";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "../components/ai-elements/attachments";
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

type UserMessageProps = {
  turn: AgentUserTurn;
  onFork?: (messageId: string) => void;
};

export const UserMessage = ({ turn }: UserMessageProps) => {
  const isTouch = useTouchPrimary();
  // A user turn wraps exactly one user step, so flattening gives back the flat
  // part list the rendering below was written against.
  const parts: AgentUserPart[] = turn.content.flatMap((step) => step.content);

  const files = parts.filter(isAgentFilePart).map((file) => ({
    filename: file.filename,
    id: nanoid(),
    mediaType: file.mediaType,
    type: file.type,
    url: file.url,
  }));

  const text = parts
    .filter(isAgentTextPart)
    .map((e) => e.text)
    .join("\n\n");

  return (
    <Message avatar={<UserAvatar />} from="user">
      {files.length > 0 && (
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
      )}
      <MessageContent>
        <div className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {renderTextToReactElement(text)}
        </div>
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
