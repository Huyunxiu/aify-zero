import type { AgentUIMessage } from "@workspace/agent";
import { nanoid } from "nanoid";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "../components/ai-elements/attachments";
import { Message, MessageContent, MessageResponse } from "./message";

type UserMessageProps = {
  message: AgentUIMessage;
};

export const UserMessage = ({ message }: UserMessageProps) => {
  if (message.role !== "user") {
    return null;
  }

  return message.parts.map((part, partIndex) => {
    if (part.type !== "text") {
      return null;
    }

    const files = message.parts
      .filter((e) => e.type === "file")
      .map((file) => ({
        filename: file.filename,
        id: nanoid(),
        mediaType: file.mediaType,
        type: file.type,
        url: file.url,
      }));

    return (
      <Message from="user" key={`${message.id}-user-text-${partIndex}`}>
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
        </MessageContent>
      </Message>
    );
  });
};
