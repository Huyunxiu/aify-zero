import { eventIteratorToUnproxiedDataStream } from "@orpc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { AgentToolSet } from "@workspace/agent";
import type {
  AgentStreamEvent,
  AgentTurn,
  AgentUserPart,
  AgentUserTurn,
} from "@workspace/agent-client";
import {
  generateSessionId,
  generateStepId,
  generateTurnId,
} from "@workspace/agent/utils/id-util";
import type { ForkSessionType } from "@workspace/server/routers/session.schema";
import { LOCAL_STORAGE_KEYS, ModelEffort } from "@workspace/shared/constants";
import { getErrorMessage } from "@workspace/shared/errors";
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
import { useAgentSession } from "../hooks/use-agent-session";
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
    mediaType: string;
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

export type AgentCommand = {
  id: string;
  type: "command";
  name: string;
  description: string;
};

export type SessionProps = React.ComponentProps<"div"> & {
  sessionId: string | undefined;
  initialTurns?: AgentTurn<AgentToolSet>[];
};

export function Session({ sessionId, initialTurns = [] }: SessionProps) {
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
      await queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
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

  const [isEditorEmpty, setIsEditorEmpty] = React.useState(true);

  // The desktop home route renders the session with no id. `useChat` used to
  // mint one; keep doing that, and keep it stable across renders so the hook's
  // store is not rebuilt under the conversation.
  const sessionKey = React.useMemo(
    () => sessionId ?? generateSessionId(),
    [sessionId]
  );

  const onEvent = React.useCallback((event: AgentStreamEvent<AgentToolSet>) => {
    if (event.type === "session.title.end") {
      // The generated title replaces the localized placeholder the sidebar
      // showed until now.
      void queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
    }
  }, []);

  const { sendTurns, turns, error } = useAgentSession({
    id: sessionKey,
    apiStream: async (options) => {
      if (!selectedModelId || !selectedModelEffort || !options.turns.length) {
        return;
      }
      const result = await client.session.create(
        {
          sessionId: options.sessionId,
          turns: [options.turns.at(-1)!],
          model: selectedModelId,
          modelEffort: selectedModelEffort,
        },
        { signal: options.abortSignal }
      );
      return eventIteratorToUnproxiedDataStream(result);
    },
    turns: initialTurns,
    onEvent,
  });

  // console.log("session page refresh.", sessionId, initialTurns.length);

  const tokenUsage =
    turns.findLast((turn) => turn.usage)?.usage || defaultTokenUsage;

  const commands: AgentCommand[] = [
    {
      id: "compact",
      type: "command",
      name: "compact",
      description: "压缩此聊天的上下文",
    },
  ];

  const handleSubmit = (message: PromptInputMessage) => {
    const modelId = selectedModelId;
    if (!modelId) {
      return;
    }

    const parts: AgentUserPart[] = [];
    if (message.files.length) {
      parts.push(
        ...message.files.map((file) => ({
          filename: file.filename,
          mediaType: file.mediaType,
          type: "file" as const,
          url: file.url,
        }))
      );
    }
    parts.push({
      type: "text",
      text: message.text,
    });

    // A user turn wraps exactly one user step, and the two are separate levels
    // with separate ids — a step's id is never the id of the turn around it.
    const turn: AgentUserTurn = {
      id: generateTurnId(),
      type: "user",
      createdAt: Date.now(),
      status: "done",
      content: [
        {
          id: generateStepId(),
          type: "user",
          createdAt: Date.now(),
          status: "done",
          content: parts,
        },
      ],
    };

    // The server writes the session row when the first turn arrives, with an
    // empty title; refresh now so the row shows up with its localized
    // placeholder, and again when the title event lands.
    if (turns.length === 0) {
      void queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
    }

    void sendTurns({
      turns: [...turns, turn],
      // A newer send cancels the older request on its own, so nothing aborts
      // this one.
      abortSignal: new AbortController().signal,
      payload: { model: modelId, modelEffort: selectedModelEffort },
    });
  };

  const renderTurn = (turn: AgentTurn<AgentToolSet>) => {
    if (turn.type === "user") {
      return <UserMessage key={turn.id} turn={turn} />;
    }

    if (turn.type === "assistant") {
      return (
        <AssistantMessage
          key={turn.id}
          turn={turn}
          onFork={(messageId) => {
            if (sessionId) {
              forkSessionMutation.mutate({ sessionId, messageId });
            }
          }}
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
                        {turns.length === 0 ? (
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
                            {turns.map((turn) => (
                              <MessageScrollerItem
                                key={turn.id}
                                messageId={turn.id}
                                scrollAnchor={turn.type === "user"}
                              >
                                {renderTurn(turn)}
                              </MessageScrollerItem>
                            ))}
                            {error && (
                              <MessageScrollerItem scrollAnchor={false}>
                                <Message from="assistant">
                                  <MessageContent>
                                    <MessageResponse className="text-destructive">
                                      {getErrorMessage(error)}
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
                    skills={
                      listSessionResourcesQuery.data?.skills.map((e) => ({
                        ...e,
                        type: "skill",
                      })) || []
                    }
                    commands={commands}
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
