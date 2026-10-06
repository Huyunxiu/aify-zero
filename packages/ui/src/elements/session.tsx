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

/**
 * Reads the turn a session is running.
 *
 * Located by session id, so a page that reloaded can ask without ever having
 * held a stream id. A session with nothing running answers `STREAM_NOT_FOUND`,
 * which is a rejection here — the caller decides whether that is worth
 * reporting.
 */
async function openStream(
  sessionId: string,
  abortSignal: AbortSignal
): Promise<ReadableStream> {
  const stream = await client.session.stream(
    { sessionId },
    { signal: abortSignal }
  );
  return eventIteratorToUnproxiedDataStream(stream);
}

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

  // A turn outlives the page that asked for it, so a page entering a session
  // asks what that session is up to rather than assuming it is idle.
  const getSessionQuery = useQuery({
    queryKey: ["getSession", sessionId],
    queryFn: async () =>
      await client.session.get({ sessionId: sessionId ?? "" }),
    enabled: Boolean(sessionId),
  });

  const activeStreamId = getSessionQuery.data?.session?.activeStreamId ?? null;

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

  const { sendTurns, turns, error, status, stop, resume } = useAgentSession({
    id: sessionKey,
    // Sending and reading are two requests. The POST is accepted and answered
    // at once — the turn runs on in the background — so its body says only that
    // it was accepted, and the events come from the GET below.
    apiStream: async (options) => {
      if (!options.model || !options.modelEffort || !options.turns.length) {
        return;
      }

      const accepted = await client.session.create(
        {
          sessionId: options.sessionId,
          turns: [options.turns.at(-1)!],
          model: options.model as string,
          modelEffort: options.modelEffort as string,
        },
        { signal: options.abortSignal }
      );
      // The desktop client reaches the server over oRPC's RPC link, which
      // always answers 200 — the 201 the REST route sends is not visible here,
      // so the accepted `streamId` is what says the turn was taken.
      if (!accepted?.activeStreamId) {
        throw new Error("The chat did not accept the message.");
      }
      return await openStream(options.sessionId, options.abortSignal);
    },
    // Stopping is located by session id, so nothing here has to carry the
    // stream id the POST handed back.
    apiStop: async ({ sessionId: id }) => {
      await client.session.stop({ sessionId: id });
    },
    turns: initialTurns,
    onEvent,
  });

  // Opening a session is reading it. A finished turn leaves the session `done`
  // — the mark the sidebar draws a check for — and the page showing that
  // transcript is what retires it: once on arrival, and again whenever a turn
  // this page watched settles back to `ready`, so a session the user is sitting
  // in does not report itself as unread.
  React.useEffect(() => {
    if (!sessionId || status !== "ready") {
      return;
    }

    const id = sessionId;

    void (async () => {
      try {
        await client.session.markRead({ sessionId: id });
        await queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
      } catch {
        // Marking read is bookkeeping, not the page's work: a session opened
        // over a broken link still shows its transcript, it just stays marked.
      }
    })();
  }, [sessionId, status]);

  const finalError =
    error ?? turns.findLast((turn) => turn.status === "error")?.error;

  // console.log("session page refresh.", sessionId, initialTurns.length);

  // Attach to a turn that is still running, once for that turn. The lookup can
  // be repeated — a refetch answers with the same stream id — but a store has
  // to attach to a given turn only once.
  const resumedStreamRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!sessionId || !activeStreamId) {
      return;
    }

    if (resumedStreamRef.current === activeStreamId) {
      return;
    }

    resumedStreamRef.current = activeStreamId;

    const id = sessionId;
    const controller = new AbortController();

    void (async () => {
      try {
        const stream = await openStream(id, controller.signal);
        await resume({ stream, abortSignal: controller.signal });
      } catch {
        // The turn can end between the lookup and the attach; there is then
        // nothing to resume, and the transcript already has it.
      }
    })();

    return () => controller.abort();
  }, [sessionId, activeStreamId, resume]);

  const tokenUsage =
    turns.findLast((turn) => turn.usage)?.usage || defaultTokenUsage;

  // The submit button doubles as the stop control, so an empty editor — which
  // is exactly what submitting leaves behind — must not disable it mid-turn.
  const isGenerating = status === "submitted" || status === "streaming";

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
                            {finalError && (
                              <MessageScrollerItem scrollAnchor={false}>
                                <Message from="assistant">
                                  <MessageContent>
                                    <MessageResponse className="text-destructive">
                                      {getErrorMessage(finalError)}
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
                      disabled={
                        !isGenerating && (!selectedModelId || isEditorEmpty)
                      }
                      status={status}
                      onStop={() => void stop()}
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
