import { useChat } from "@ai-sdk/react";
import { eventIteratorToUnproxiedDataStream } from "@orpc/client";
import type { AgentUIMessage } from "@workspace/agent";
import { MessageSquareIcon } from "lucide-react";
import { Fragment } from "react/jsx-runtime";

import { client } from "../lib/orpc";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./conversation";
import { Message, MessageContent } from "./message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "./prompt-input";
import type { PromptInputMessage } from "./prompt-input";
import { TitleBar } from "./title-bar";

type ThreadProps = React.ComponentProps<"div">;

function Thread() {
  const { sendMessage, messages } = useChat<AgentUIMessage>({
    transport: {
      reconnectToStream() {
        throw new Error("Unsupported");
      },
      async sendMessages(options) {
        return eventIteratorToUnproxiedDataStream(
          await client.thread(
            {
              threadId: options.chatId,
              messages: options.messages,
            },
            { signal: options.abortSignal }
          )
        );
      },
    },
  });

  const handleSubmit = (message: PromptInputMessage) => {
    console.log("handleSubmit", messages, message);
    void sendMessage({ text: message.text });
  };

  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div className="flex min-w-0 flex-col w-full">
        {/* thread header */}
        <TitleBar className="sticky top-0 flex h-14 items-center gap-2 bg-sidebar px-3" />
        {/* thread container */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          {/* thread content */}
          <div className="relative flex-1 bg-background">
            <div className="absolute inset-0 touch-pan-y overflow-y-auto bg-background">
              <Conversation className="relative size-full mx-auto flex min-h-full min-w-0 max-w-4xl flex-col gap-5 py-6 md:gap-7">
                <ConversationContent>
                  {messages.length === 0 ? (
                    <ConversationEmptyState
                      description="Messages will appear here as the conversation progresses."
                      icon={<MessageSquareIcon className="size-6" />}
                      title="Start a conversation"
                    />
                  ) : (
                    messages.map((message) =>
                      message.parts.map((part, i) => {
                        switch (part.type) {
                          case "text": {
                            return (
                              <Fragment key={`${message.id}-${i}`}>
                                <Message from={message.role}>
                                  <MessageContent>{part.text}</MessageContent>
                                </Message>
                              </Fragment>
                            );
                          }
                          case "custom": {
                            return <></>;
                          }
                          case "dynamic-tool": {
                            return <></>;
                          }
                          case "file": {
                            return <></>;
                          }
                          case "reasoning": {
                            return <></>;
                          }
                          case "reasoning-file": {
                            return <></>;
                          }
                          case "source-document": {
                            return <></>;
                          }
                          case "source-url": {
                            return <></>;
                          }
                          case "step-start": {
                            return <></>;
                          }
                          default: {
                            return <></>;
                          }
                        }
                      })
                    )
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            </div>
          </div>

          {/* thread input */}
          <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 py-3 md:px-4 md:pb-4">
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                <PromptInputTextarea />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools></PromptInputTools>
                <PromptInputSubmit />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { ThreadProps };
export { Thread };
