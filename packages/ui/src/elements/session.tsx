import { useChat } from "@ai-sdk/react";
import { eventIteratorToUnproxiedDataStream } from "@orpc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { AgentUIMessage } from "@workspace/agent";
import { generateMessageId } from "@workspace/agent/utils/id-util";
import type { ForkSessionType } from "@workspace/server/routers/session.schema";
import { LOCAL_STORAGE_KEYS, ModelEffort } from "@workspace/shared/constants";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import type { LanguageModelUsage } from "ai";
import { MessageSquareIcon } from "lucide-react";
import * as React from "react";
import { memo, useCallback } from "react";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "../components/ai-elements/attachments";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "../components/ai-elements/token-context";
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
import { client, queryClient } from "../lib/orpc";
import { AssistantMessage } from "./assistant-message";
import { Message, MessageContent, MessageResponse } from "./message";
import { ModelSelect } from "./model-select";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTools,
  usePromptInputAttachments,
} from "./prompt-input";
import type { PromptInputMessage } from "./prompt-input";
import { PromptInputTiptap } from "./prompt-input-tiptap";
import { TitleBar } from "./title-bar";
import { UserMessage } from "./user-message";

const defaultTokenUsage: LanguageModelUsage = {
  inputTokens: 0,
  inputTokenDetails: {
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 0,
  outputTokenDetails: {
    textTokens: 0,
    reasoningTokens: 0,
  },
  totalTokens: 0,
};

interface AttachmentItemProps {
  attachment: {
    id: string;
    type: "file";
    filename?: string;
    mediaType?: string;
    url: string;
  };
  onRemove: (id: string) => void;
}

const AttachmentItem = memo(({ attachment, onRemove }: AttachmentItemProps) => {
  const handleRemove = useCallback(
    () => onRemove(attachment.id),
    [onRemove, attachment.id]
  );
  return (
    <Attachment data={attachment} key={attachment.id} onRemove={handleRemove}>
      <AttachmentPreview />
      <AttachmentRemove />
    </Attachment>
  );
});

AttachmentItem.displayName = "AttachmentItem";

const PromptInputAttachmentsDisplay = () => {
  const attachments = usePromptInputAttachments();

  const handleRemove = useCallback(
    (id: string) => attachments.remove(id),
    [attachments]
  );

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <Attachments variant="grid">
      {attachments.files.map((attachment) => (
        <AttachmentItem
          attachment={attachment}
          key={attachment.id}
          onRemove={handleRemove}
        />
      ))}
    </Attachments>
  );
};

export type SessionProps = React.ComponentProps<"div"> & {
  sessionId: string | undefined;
  initialMessages?: AgentUIMessage[];
};

export function Session({ sessionId, initialMessages }: SessionProps) {
  const navigate = useNavigate();

  const getSettingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
  });

  const listSessionResourcesQuery = useQuery({
    queryKey: ["listSessionResources", sessionId],
    queryFn: async () =>
      await client.session.listSessionResources({ sessionId: sessionId ?? "" }),
  });

  const forkSessionMutation = useMutation({
    mutationFn: async (options: ForkSessionType) =>
      await client.session.fork(options),
    onSuccess: async ({ sessionId: forkSessionId }) => {
      await queryClient.invalidateQueries({ queryKey: ["list_chats"] });
      await navigate({ to: `/sessions/${forkSessionId}` });
    },
  });

  const models = getSettingsQuery.data?.models ?? [];
  const [selectedModelId, setSelectedModelId] = React.useState<
    string | undefined
  >(() => localStorage.getItem(LOCAL_STORAGE_KEYS.MODEL_ID) ?? undefined);
  const [selectedModelEffort, setSelectedModelEffort] = React.useState<
    ModelEffort | undefined
  >(() => {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEYS.MODEL_EFFORT);
    return stored && Object.values(ModelEffort).includes(stored as ModelEffort)
      ? (stored as ModelEffort)
      : undefined;
  });

  // Restore the last used model, falling back to the first one.
  React.useEffect(() => {
    if (models.length > 0 && !models.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(models[0]!.id);
    }
  }, [models, selectedModelId]);

  const handleModelChange = (modelId: string) => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.MODEL_ID, modelId);
    setSelectedModelId(modelId);
  };

  const handleModelEffortChange = (effort: ModelEffort) => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.MODEL_EFFORT, effort);
    setSelectedModelEffort(effort);
  };

  const selectedModelIdRef = React.useRef(selectedModelId);
  selectedModelIdRef.current = selectedModelId;
  const selectedEffortRef = React.useRef(selectedModelEffort);
  selectedEffortRef.current = selectedModelEffort;
  const [isEditorEmpty, setIsEditorEmpty] = React.useState(true);

  const {
    sendMessage,
    messages,
    addToolOutput,
    addToolApprovalResponse,
    regenerate,
    error,
    status,
  } = useChat<AgentUIMessage>({
    messages: initialMessages,
    id: sessionId,
    generateId: generateMessageId,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport: {
      reconnectToStream() {
        throw new Error("Unsupported");
      },
      async sendMessages(options) {
        const modelId = selectedModelIdRef.current;
        if (!modelId) {
          return;
        }

        const stream = eventIteratorToUnproxiedDataStream(
          await client.session.create(
            {
              sessionId: options.chatId,
              messages: options.messages,
              model: modelId,
              modelEffort: selectedEffortRef.current,
            },
            { signal: options.abortSignal }
          )
        );

        // oxlint-disable-next-line typescript/no-unsafe-return
        return stream as any;
      },
    },
  });

  const tokenUsage =
    messages.findLast((e) => e.metadata?.usage)?.metadata?.usage ||
    defaultTokenUsage;

  const handleSubmit = (message: PromptInputMessage) => {
    console.log("handleSubmit", messages, message);
    sendMessage({
      role: "user",
      id: generateMessageId(),
      parts: [
        ...message.files.map((file) => ({
          mediaType: file.mediaType,
          name: file.filename,
          type: "file" as const,
          url: file.url,
        })),
        {
          text: message.text,
          type: "text",
        },
      ],
    });
  };

  const renderMessage = (message: AgentUIMessage) => {
    if (message.role === "user") {
      return <UserMessage key={message.id} message={message} />;
    }

    if (message.role === "assistant") {
      return (
        <AssistantMessage
          loading={status === "streaming" || status === "submitted"}
          onFork={(messageId) => {
            if (sessionId) {
              forkSessionMutation.mutate({ sessionId, messageId });
            }
          }}
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
    <div className="flex h-full w-full flex-row overflow-hidden">
      <div className="flex min-w-0 flex-col w-full">
        {/* session header */}
        <TitleBar className="sticky top-0 flex h-14 items-center gap-2 px-3" />
        {/* session container */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* session content */}
          <div className="relative flex-1">
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
          <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 px-2 py-3 pt-1 md:px-4 md:pb-4">
            <PromptInputProvider>
              <PromptInput
                multiple
                maxFileSize={5 * 1024 * 1024}
                accept="image/png,image/jpeg,image/webp"
                onSubmit={handleSubmit}
                onError={console.error}
              >
                <PromptInputAttachmentsDisplay />
                <PromptInputBody>
                  {/* <PromptInputTextarea /> */}
                  <PromptInputTiptap
                    resources={listSessionResourcesQuery.data}
                    onEmptyChange={(isEmpty) => {
                      if (isEmpty !== isEditorEmpty) {
                        setIsEditorEmpty(isEmpty);
                      }
                    }}
                  />
                </PromptInputBody>
                <PromptInputFooter>
                  <PromptInputTools className="gap-0">
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger />
                      <PromptInputActionMenuContent className="min-w-max">
                        <PromptInputActionAddAttachments />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                    <ModelSelect
                      models={models}
                      modelId={selectedModelId}
                      modelEffort={selectedModelEffort}
                      onModelChange={handleModelChange}
                      onModelEffortChange={handleModelEffortChange}
                    />
                  </PromptInputTools>
                  <div className="flex items-center gap-2">
                    <Context
                      maxTokens={128_000}
                      modelId={selectedModelId}
                      usage={tokenUsage}
                      usedTokens={tokenUsage.totalTokens || 0}
                    >
                      <ContextTrigger />
                      <ContextContent>
                        <ContextContentHeader />
                        <ContextContentBody>
                          <ContextInputUsage />
                          <ContextOutputUsage />
                          <ContextReasoningUsage />
                          <ContextCacheUsage />
                        </ContextContentBody>
                        <ContextContentFooter />
                      </ContextContent>
                    </Context>
                    <PromptInputSubmit
                      disabled={!selectedModelId || isEditorEmpty}
                    />
                  </div>
                </PromptInputFooter>
              </PromptInput>
            </PromptInputProvider>
          </div>
        </div>
      </div>
    </div>
  );
}
