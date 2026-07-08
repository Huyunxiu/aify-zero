import { useChat } from "@ai-sdk/react";
import { eventIteratorToUnproxiedDataStream } from "@orpc/client";
import type { AgentUIMessage } from "@workspace/agent";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { MessageSquareIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../components/message-scroller";
import { client } from "../lib/orpc";
import { AssistantMessage } from "./assistant-message";
import { Message, MessageContent, MessageResponse } from "./message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "./prompt-input";
import type { PromptInputMessage } from "./prompt-input";
import { PromptInputTiptap } from "./prompt-input-tiptap";
import { TitleBar } from "./title-bar";
import { UserMessage } from "./user-message";

export type SessionProps = React.ComponentProps<"div"> & {
  sessionId: string | undefined;
  initialMessages?: AgentUIMessage[];
};

export function Session({ sessionId, initialMessages }: SessionProps) {
  const {
    sendMessage,
    messages,
    addToolOutput,
    addToolApprovalResponse,
    regenerate,
    error,
  } = useChat<AgentUIMessage>({
    messages: initialMessages,
    id: sessionId,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport: {
      reconnectToStream() {
        throw new Error("Unsupported");
      },
      async sendMessages(options) {
        return eventIteratorToUnproxiedDataStream(
          await client.session.create(
            {
              sessionId: options.chatId,
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

  const renderMessage = (message: AgentUIMessage) => {
    if (message.role === "user") {
      return <UserMessage key={message.id} message={message} />;
    }

    if (message.role === "assistant") {
      return (
        <AssistantMessage
          addToolApprovalResponse={addToolApprovalResponse}
          addToolOutput={addToolOutput}
          key={message.id}
          message={message}
          regenerate={regenerate}
        />
      );
    }

    return null;
  };

  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div className="flex min-w-0 flex-col w-full">
        {/* session header */}
        <TitleBar className="sticky top-0 flex h-14 items-center gap-2 bg-background px-3" />
        {/* session container */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          {/* session content */}
          <div className="relative flex-1 bg-background">
            <div className="absolute inset-0 touch-pan-y overflow-y-auto bg-transparent">
              <div className="relative size-full mx-auto flex min-h-full min-w-0 max-w-4xl flex-col">
                <MessageScrollerProvider
                  scrollPreviousItemPeek={64}
                  defaultScrollPosition="start"
                  autoScroll
                >
                  <MessageScroller>
                    <MessageScrollerViewport>
                      <MessageScrollerContent className="px-3 py-3 md:px-5 md:py-5">
                        {messages.length === 0 ? (
                          <Empty className="h-full">
                            <EmptyHeader>
                              <EmptyMedia variant="icon">
                                <MessageSquareIcon />
                              </EmptyMedia>
                              <EmptyTitle>Start a session</EmptyTitle>
                              <EmptyDescription>
                                Messages will appear here as the session
                                progresses.
                              </EmptyDescription>
                            </EmptyHeader>
                          </Empty>
                        ) : (
                          <>
                            {messages.map((message) => (
                              <MessageScrollerItem
                                key={message.id}
                                messageId={message.id}
                                scrollAnchor={message.role === "user"}
                              >
                                {renderMessage(message)}
                              </MessageScrollerItem>
                            ))}
                            {error && (
                              <MessageScrollerItem scrollAnchor={false}>
                                <Message from="assistant">
                                  <MessageContent>
                                    <MessageResponse className="text-destructive">
                                      {error.message}
                                    </MessageResponse>
                                  </MessageContent>
                                </Message>
                              </MessageScrollerItem>
                            )}
                          </>
                        )}
                      </MessageScrollerContent>
                    </MessageScrollerViewport>
                    <MessageScrollerButton />
                  </MessageScroller>
                </MessageScrollerProvider>
              </div>
            </div>
          </div>

          {/* session input */}
          <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 py-3 pt-1 md:px-4 md:pb-4">
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                {/* <PromptInputTextarea /> */}
                <PromptInputTiptap onSubmit={handleSubmit} />
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
