import type { AgentUserPart, AgentUserTurn } from "@workspace/agent-client";
import { isAgentFilePart, isAgentTextPart } from "@workspace/agent-client";
import { nanoid } from "nanoid";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "../components/ai-elements/attachments";
import { Message, MessageContent } from "./message";
import { renderTextToReactElement } from "./prompt-input-tiptap";

type UserMessageProps = {
  turn: AgentUserTurn;
};

export const UserMessage = ({ turn }: UserMessageProps) => {
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
    <Message from="user">
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
    </Message>
  );
};
