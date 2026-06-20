import type { UseChatHelpers } from "@ai-sdk/react";
import type { AgentUIMessage } from "@workspace/agent";

import { Message, MessageContent, MessageResponse } from "./message";

type AssistantMessageProps = {
  message: AgentUIMessage;
  regenerate: UseChatHelpers<AgentUIMessage>["regenerate"];
  addToolOutput: UseChatHelpers<AgentUIMessage>["addToolOutput"];
  addToolApprovalResponse: UseChatHelpers<AgentUIMessage>["addToolApprovalResponse"];
};

export const AssistantMessage = ({
  addToolOutput,
  addToolApprovalResponse,
  message,
  regenerate,
}: AssistantMessageProps) => {
  if (message.role !== "assistant") {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      {message.parts.map((e, i) => {
        if (e.type === "text") {
          return (
            <Message from="assistant" key={`${i}`}>
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
                  {e.text}
                </MessageResponse>
              </MessageContent>
            </Message>
          );
        }
        return null;
      })}
    </div>
  );
};
