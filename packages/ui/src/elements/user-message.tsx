import type { AgentUIMessage } from "@workspace/agent";

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

    return (
      <Message from="user" key={`${message.id}-user-text-${partIndex}`}>
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
