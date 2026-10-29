import { eventIteratorToUnproxiedDataStream } from "@orpc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { AgentToolSet } from "@workspace/agent";
import { isAgentTextPart } from "@workspace/agent-client";
import type {
  AgentAssistantTurn,
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
import { MessageSquareIcon, XIcon } from "lucide-react";
import * as React from "react";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "../components/ai-elements/attachments";
import type { ToolApprovalAnswer } from "../components/ai-elements/chain-of-turn";
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
import { Button } from "../components/button";
import { ButtonGroup } from "../components/button-group";
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
  useMessageScroller,
  useMessageScrollerVisibility,
} from "../components/message-scroller";
import { toastManager } from "../components/toast";
import ProximitySidebar from "../components/ui/proximity-sidebar";
import type { ProximitySection } from "../components/ui/proximity-sidebar";
import { useAgentSession } from "../hooks/use-agent-session";
import type { SubmitMode } from "../hooks/use-agent-session";
import { client, queryClient } from "../lib/orpc";
import { cn } from "../lib/utils";
import { AssistantMessage } from "./assistant-message";
import { CompactionMessage } from "./compaction-message";
import { InboxDock } from "./inbox-dock";
import { Message, MessageContent, MessageResponse } from "./message";
import { ModelSelect } from "./model-select";
import { ProjectSelect } from "./project-select";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputStop,
  PromptInputSubmit,
  PromptInputTools,
  usePromptInputAttachments,
} from "./prompt-input";
import type { PromptInputMessage } from "./prompt-input";
import { PromptInputTiptap } from "./prompt-input-tiptap";
import { parseLeadingCommand } from "./prompt-tag";
import {
  findPendingQuestionnaire,
  QuestionnaireComposer,
} from "./questionnaire";
import type { QuestionnairePlacement } from "./questionnaire";
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
  /**
   * 新建会话时预选的项目。
   *
   * 只作为初始值。会话行一旦存在，行上的项目就是唯一事实源；首次落库后
   * 不能再改，否则后续回合会跑到别的目录。
   */
  initialProjectId?: string;
  /**
   * Whether the session is being read rather than written to.
   *
   * A subagent's is: its turns belong to the `task` call that made it, and
   * nothing outside that call can answer a call it was held on. The composer,
   * the approval buttons and the fork action are left out, so the page shows
   * the transcript and nothing it cannot honour.
   */
  readOnly?: boolean;
  /**
   * Where a held questionnaire draws its form.
   *
   * `"composer"` — the default — puts it where the prompt input stands, and the
   * prompt input comes back once the questionnaire has been answered or
   * declined. `"inline"` leaves it in the transcript, beside the call that
   * asked. Either one can be chosen per surface without changing the form.
   */
  questionnairePlacement?: QuestionnairePlacement;
  /**
   * Closes whatever is showing this session. A pane that can be pointed at
   * another session needs a way back to its own, and the title bar is where a
   * reader looks for it.
   */
  onClose?: () => void;
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

const OUTLINE_LABEL_MAX = 48;

type OutlineTurn = AgentUserTurn | AgentAssistantTurn<AgentToolSet>;

/**
 * 轮次在大纲里的名字。
 *
 * 取它写下的文本并压成一行；只发了附件、或答复还没写出文字的轮次，
 * 用序号代替。名字只用来做读屏标签和悬停提示，不出现在页面上。
 */
function getOutlineLabel(turn: OutlineTurn, index: number): string {
  const textParts: string[] = [];

  for (const step of turn.content) {
    if (step.type === "compaction") {
      continue;
    }

    // 引导消息是回合中用户插的话，不进入回复的大纲标题。
    if (step.type === "steering") {
      continue;
    }

    for (const part of step.content) {
      if (isAgentTextPart(part)) {
        textParts.push(part.text);
      }
    }
  }

  const text = textParts.join(" ").replace(/\s+/g, " ").trim();

  if (text.length === 0) {
    return `#${index + 1}`;
  }

  return text.length > OUTLINE_LABEL_MAX
    ? `${text.slice(0, OUTLINE_LABEL_MAX)}…`
    : text;
}

interface SessionOutlineProps {
  sections: ProximitySection[];
}

/**
 * 会话大纲：标出读者正在看的那一条，点一下就跳过去。
 *
 * 大纲里有答复，而滚动锚点只标用户轮次。所以位置取可见消息里的第一条：
 * 它正好压在视口上方的阅读线上，答复滚到那里时也会接替前一问。
 * 跳转交给 scrollToMessage，和“跳到某条消息”是同一个动作。
 */
function SessionOutline({ sections }: SessionOutlineProps) {
  const { t } = useTranslation();
  const { currentAnchorId, visibleMessageIds } = useMessageScrollerVisibility();
  const { scrollToMessage } = useMessageScroller();

  const sectionIds = React.useMemo(
    () => new Set(sections.map((section) => section.id)),
    [sections]
  );
  const activeId =
    visibleMessageIds.find((id) => sectionIds.has(id)) ??
    currentAnchorId ??
    sections[0]?.id;

  return (
    <ProximitySidebar
      activeId={activeId}
      className="py-6"
      label={t("sessions.outline")}
      onSelect={(id) => {
        scrollToMessage(id, { align: "start", behavior: "smooth" });
      }}
      sections={sections}
      side="left"
    />
  );
}

export function Session({
  sessionId,
  initialTurns = [],
  initialProjectId,
  readOnly = false,
  questionnairePlacement = "composer",
  onClose,
}: SessionProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();

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

  // Same query key as the sidebar, so creating a project there makes it
  // selectable here without another round trip.
  const listProjectsQuery = useQuery({
    queryKey: ["list_projects"],
    queryFn: () => client.project.list(),
  });

  const activeStreamId = getSessionQuery.data?.session?.activeStreamId ?? null;
  // 会话标题：顶层会话是生成标题，子会话是 `task` 调用交给它的任务简述。
  // 侧边栏收起后，标题栏是唯一还能看到它的地方。
  const sessionTitle = getSessionQuery.data?.session?.title;

  const forkSessionMutation = useMutation({
    mutationFn: async (options: ForkSessionType) =>
      await client.session.fork(options),
    onSuccess: async ({ sessionId: forkSessionId }) => {
      await queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
      await navigate({ to: `/sessions/${forkSessionId}` });
    },
  });

  const models = React.useMemo(
    () => getSettingsQuery.data?.models ?? [],
    [getSettingsQuery.data?.models]
  );
  const [selectedModelId, setSelectedModelId] = React.useState<
    string | undefined
  >(() => localStorage.getItem(LOCAL_STORAGE_KEYS.MODEL_ID) ?? undefined);
  const [selectedModelEffort, setSelectedModelEffort] = React.useState<
    ModelEffort | undefined
  >(() => {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEYS.MODEL_EFFORT);
    return stored && Object.values(ModelEffort).includes(stored as ModelEffort)
      ? (stored as ModelEffort)
      : "default";
  });

  // 运行中按 Enter 的默认投递方式；空闲时这个值不参与发送。默认 steering，
  // 与产品的选择一致。
  const [busyMode, setBusyMode] = React.useState<SubmitMode>(() =>
    localStorage.getItem(LOCAL_STORAGE_KEYS.COMPOSER_BUSY_MODE) === "followup"
      ? "followup"
      : "steering"
  );

  const handleBusyModeChange = (mode: SubmitMode) => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.COMPOSER_BUSY_MODE, mode);
    setBusyMode(mode);
  };

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

  const projects = React.useMemo(
    () => listProjectsQuery.data?.projects ?? [],
    [listProjectsQuery.data?.projects]
  );

  const [selectedProjectId, setSelectedProjectId] = React.useState<
    string | undefined
  >(initialProjectId);

  // An existing session's row is the source of truth: `session.create` writes
  // the project on insert only, so a reloaded page has to read it back from
  // there to keep showing the directories the session runs in. A new session
  // has no row yet, so the project picked in the sidebar stays selected.
  const sessionProjectId =
    getSessionQuery.data?.session?.projectId ?? undefined;

  React.useEffect(() => {
    if (getSessionQuery.data?.session) {
      setSelectedProjectId(sessionProjectId);
    }
  }, [getSessionQuery.data?.session, sessionProjectId]);

  const [isEditorEmpty, setIsEditorEmpty] = React.useState(true);

  // The desktop home route renders the session with no id. `useChat` used to
  // mint one; keep doing that, and keep it stable across renders so the hook's
  // store is not rebuilt under the conversation.
  const sessionKey = React.useMemo(
    () => sessionId ?? generateSessionId(),
    [sessionId]
  );

  const onEvent = React.useCallback(
    (event: AgentStreamEvent<AgentToolSet>) => {
      if (event.type === "session.title.end") {
        // 生成的标题替换侧边栏里的占位标题；标题栏读的是同一个会话行，
        // 所以两处一起失效。
        void queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
        if (sessionId) {
          void queryClient.invalidateQueries({
            queryKey: ["getSession", sessionId],
          });
        }
      }
    },
    [sessionId]
  );

  const {
    turns,
    pendingMessages,
    submit,
    sendPending,
    cancelPending,
    clearPending,
    error: sessionError,
    status,
    stop,
    resume,
    addToolApprovalResponse,
  } = useAgentSession({
    id: sessionKey,
    // Sending and reading are two requests. The POST is accepted and answered
    // at once — the turn runs on in the background — so its body says only that
    // it was accepted, and the events come from the GET below.
    apiStream: async (options) => {
      if (!options.model || !options.modelEffort || !options.turns.length) {
        return;
      }

      // 项目随消息发出，不能从 store 的闭包里读：store 在挂载时就建好了，
      // 那时还没选项目。hook 只把 payload 当不透明数据，所以这里收窄再传。
      const projectId =
        typeof options.projectId === "string" ? options.projectId : undefined;
      // 排队消息领取时带上 Inbox 行 id：服务端在保存 user turn 的同一事务里
      // 删除它，重复领取会失败而不是写出重复 turn。
      const inboxId =
        typeof options.inboxId === "string" ? options.inboxId : undefined;

      const accepted = await client.session.create(
        {
          sessionId: options.sessionId,
          turns: options.approvals?.length ? [] : [options.turns.at(-1)!],
          model: options.model as string,
          modelEffort: options.modelEffort as string,
          // 项目只在会话首次落库时写入；省略它，会话就落到默认项目。
          projectId,
          // An answer to a held call travels with the turn it answers. Its
          // presence is what makes the new stream a resumption: the server runs
          // the calls it names before asking the model anything again.
          approvals: options.approvals,
          inboxId,
        },
        { signal: options.abortSignal }
      );
      // 还有未审批的工具，不能继续执行
      if (accepted.awaitingToolApprovals > 0) {
        return;
      }
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
    apiInbox: {
      list: async ({ sessionId: id }) => {
        const result = await client.session.listInbox({ sessionId: id });
        return result.messages;
      },
      enqueue: async (input) => await client.session.enqueueInbox(input),
      cancel: async ({ sessionId: id, messageId }) =>
        await client.session.cancelInbox({ sessionId: id, messageId }),
      clear: async ({ sessionId: id }) =>
        await client.session.clearInbox({ sessionId: id }),
    },
    // 只读的子会话没有 composer：不渲染队列，也不 drain。
    allowSend: !readOnly,
    turns: initialTurns,
    onEvent,
  });

  // The held questionnaire whose form belongs in the composer's slot. Reading
  // it from the transcript rather than from the last event keeps the placement
  // honest across reloads and resumptions: a page that attaches to a held turn
  // still offers the form, and one that attaches after it was answered does
  // not. Inline placement leaves the form to the transcript.
  const pendingQuestionnaire = React.useMemo(
    () =>
      readOnly || questionnairePlacement !== "composer"
        ? undefined
        : findPendingQuestionnaire(turns),
    [turns, readOnly, questionnairePlacement]
  );

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
    sessionError ?? turns.findLast((turn) => turn.status === "error")?.error;

  // 大纲列出提问和答复。答复在流式输出时文字一直在变；按轮次 id 和状态
  // 命中缓存，只在答复落定时重取一次名字，侧边栏不跟着每个 token 重建。
  //
  // 滚动锚点仍然只给用户轮次：MessageScroller 用锚点决定新内容的落点，
  // 把答复也标成锚点会让每段答复都往视口顶上跳。
  const outlineCacheRef = React.useRef<{
    key: string;
    sections: ProximitySection[];
  }>({ key: "", sections: [] });

  const outlineSections = React.useMemo(() => {
    const outlineTurns = turns.filter(
      (turn): turn is OutlineTurn =>
        turn.type === "user" || turn.type === "assistant"
    );
    const key = outlineTurns
      .map(
        (turn) => `${turn.id}:${turn.type === "assistant" ? turn.status : ""}`
      )
      .join("|");

    if (outlineCacheRef.current.key === key) {
      return outlineCacheRef.current.sections;
    }

    const sections = outlineTurns.map((turn, index) => ({
      id: turn.id,
      kind: "title" as const,
      label: getOutlineLabel(turn, index),
      level: 1 as const,
    }));

    outlineCacheRef.current = { key, sections };
    return sections;
  }, [turns]);

  // 大纲和滚动容器是并排的两个盒子；滚轮落在大纲上时要交回聊天记录。
  const contentRef = React.useRef<HTMLDivElement>(null);
  const hasOutline = outlineSections.length > 1;

  // Attach to a turn that is still running, once for that turn. The lookup can
  // be repeated — a refetch answers with the same stream id — but a store has
  // to attach to a given turn only once.
  const resumedStreamRef = React.useRef<string | null>(null);

  // Attach to a run that is still going, once for that run. The lookup can be
  // repeated — a refetch answers with the same stream id — but a store has to
  // attach to a given run only once.
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
  }, [activeStreamId, resume, sessionId]);

  const tokenUsage =
    turns.findLast((turn) => turn.usage)?.usage || defaultTokenUsage;

  // 压缩之后，最近一次 usage 描述的是一个已经不存在的 prompt；上下文环应优先
  // 采用压缩记录里的估算，否则刚压缩完反而会显示压缩前的占用（手工 marker 的
  // usage 甚至是零）。
  const contextUsedTokens = React.useMemo(() => {
    let usage: { at: number; tokens: number } | undefined;
    let latestCompaction: { at: number; tokens: number } | undefined;

    for (const turn of turns) {
      for (const step of turn.content) {
        if (step.type === "compaction") {
          const record = step.content.find(
            (part) => part.type === "compaction"
          )?.record;
          if (
            record &&
            (!latestCompaction || record.createdAt >= latestCompaction.at)
          ) {
            latestCompaction = {
              at: record.createdAt,
              tokens: record.tokensAfter,
            };
          }
        } else if (step.type === "assistant" && step.usage) {
          const tokens = step.usage.totalTokens ?? 0;
          if (tokens > 0 && (!usage || step.createdAt >= usage.at)) {
            usage = { at: step.createdAt, tokens };
          }
        }
      }
    }

    return latestCompaction && (!usage || latestCompaction.at >= usage.at)
      ? latestCompaction.tokens
      : (usage?.tokens ?? 0);
  }, [turns]);

  const configuredContextWindow = models.find(
    (model) => model.id === selectedModelId
  )?.limit?.context;
  const contextWindow =
    configuredContextWindow !== undefined && configuredContextWindow > 0
      ? configuredContextWindow
      : 128_000;

  // The submit button doubles as the stop control, so an empty editor — which
  // is exactly what submitting leaves behind — must not disable it mid-turn.
  const isGenerating = status === "submitted" || status === "streaming";
  const submitLabel = isGenerating
    ? busyMode === "steering"
      ? t("composer.send.steering")
      : t("composer.send.followup")
    : t("composer.send.default");

  // A project is fixed once the session exists: later turns have to keep
  // running in the directories its first turn was started with.
  const isProjectLocked =
    Boolean(getSessionQuery.data?.session) || turns.length > 0;

  const commands: AgentCommand[] = [
    {
      id: "compact",
      type: "command",
      name: "compact",
      description: "压缩此聊天的上下文",
    },
  ];

  /**
   * Runs `/compact` as a stream of its own.
   *
   * The server only starts the compaction and answers with a stream id; the
   * summarization itself runs in the background. The compaction turn is
   * appended to the branch like any other turn — the cut point lives in its
   * record — so attaching to the stream and letting the assembler append it is
   * enough: the local transcript stays a prefix of the branch.
   */
  const handleCompact = async (modelId: string): Promise<void> => {
    if (!sessionId) {
      toastManager.add({
        description: t("compaction.noSession"),
        title: t("compaction.failed"),
        type: "error",
      });
      return;
    }

    try {
      await client.session.compact({ model: modelId, sessionId });
    } catch (error) {
      // Refused synchronously — busy session, or nothing to compact.
      toastManager.add({
        description: getErrorMessage(error),
        title: t("compaction.failed"),
        type: "error",
      });
      return;
    }

    const controller = new AbortController();

    try {
      const stream = await openStream(sessionId, controller.signal);
      await resume({ abortSignal: controller.signal, stream });
    } catch {
      // The run can end between the POST and the attach; the transcript already
      // has everything the stream would have replayed.
    }

    // The marker is in the branch now; refresh the row and the cached branch so
    // a remount sees the same thing the transcript just showed.
    void queryClient.invalidateQueries({
      queryKey: ["listSessionTurns", sessionId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["getSession", sessionId],
    });
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const modelId = selectedModelId;
    if (!modelId) {
      return;
    }

    const command = parseLeadingCommand(message.text);
    if (command?.id === "compact") {
      const rest = message.text
        .replace(/^\[@[^\]]+\]\(command:\/\/[^)]+\)/, "")
        .trim();
      if (rest.length > 0 || message.files.length > 0) {
        toastManager.add({
          description: t("compaction.commandOnly"),
          title: t("compaction.failed"),
          type: "error",
        });
        return;
      }

      // The editor empties once this returns; the run continues on screen as
      // the compaction turn the stream writes.
      void handleCompact(modelId);
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
      createdAt: Date.now(),
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

    try {
      // 新会话直接发送；已有会话先入队，再按顺序 drain。空闲时 mode 不参与。
      await submit({
        turn,
        mode: isGenerating ? busyMode : undefined,
        payload: {
          model: modelId,
          modelEffort: selectedModelEffort,
          projectId: selectedProjectId,
        },
      });
    } catch (error) {
      // 入队或发送被拒绝时，PromptInput 不会清空编辑器；这里负责让用户看到原因。
      toastManager.add({
        description: getErrorMessage(error),
        title: t("requestFailed"),
        type: "error",
      });
      throw error;
    }
  };

  const reportQueueError = (error: unknown) => {
    toastManager.add({
      description: getErrorMessage(error),
      title: t("requestFailed"),
      type: "error",
    });
  };

  const handleQueueSend = () => {
    void sendPending().catch(reportQueueError);
  };

  const handleQueueCancel = (messageId: string) => {
    void cancelPending(messageId).catch(reportQueueError);
  };

  const handleQueueClear = () => {
    void clearPending().catch(reportQueueError);
  };

  const handleRespondToolApproval = React.useCallback(
    (approvalId: string, approved: boolean, answer?: ToolApprovalAnswer) => {
      if (!selectedModelId) {
        return;
      }

      // The transcript goes back exactly as it stands, with the answer beside
      // it: no user turn is added, because the held turn is already the last
      // one and the answer belongs to it.
      void addToolApprovalResponse({
        approvalId,
        approved,
        reason: answer?.reason,
        data: answer?.data,
        payload: {
          model: selectedModelId,
          modelEffort: selectedModelEffort,
          projectId: selectedProjectId,
        },
      });
    },
    [
      addToolApprovalResponse,
      selectedModelId,
      selectedModelEffort,
      selectedProjectId,
    ]
  );

  const renderTurn = (turn: AgentTurn<AgentToolSet>) => {
    if (turn.type === "user") {
      return <UserMessage key={turn.id} turn={turn} />;
    }

    if (turn.type === "compaction") {
      const [step] = turn.content;
      const record = step?.content.find(
        (part) => part.type === "compaction"
      )?.record;
      return <CompactionMessage key={turn.id} record={record} />;
    }

    if (turn.type === "assistant") {
      return (
        <AssistantMessage
          key={turn.id}
          turn={turn}
          // A read-only page answers nothing: a call it was held on has no one
          // here to decide for it, and the row says so rather than offering
          // buttons that cannot work.
          onRespondToolApproval={
            readOnly ? undefined : handleRespondToolApproval
          }
          questionnairePlacement={questionnairePlacement}
          onFork={
            readOnly
              ? undefined
              : (messageId) => {
                  if (sessionId) {
                    forkSessionMutation.mutate({ sessionId, messageId });
                  }
                }
          }
        />
      );
    }

    return null;
  };

  return (
    <div className="flex h-full w-full flex-row overflow-hidden">
      <div className="@container flex min-w-0 flex-col w-full">
        {/* session header */}
        <TitleBar className="sticky top-0 flex h-12 items-center gap-2 px-4">
          {sessionId && (
            <div className="min-w-0 truncate text-foreground text-sm max-w-md">
              {onClose
                ? sessionTitle
                  ? `Subagent · ${sessionTitle}`
                  : "Subagent"
                : sessionTitle || t("sessions.untitled")}
            </div>
          )}
          {onClose && (
            <Button
              aria-label="Close"
              // The bar is the window's drag region; a control in it has to
              // opt back out of that, or the click drags the window.
              className="ml-auto [-webkit-app-region:no-drag]"
              onClick={onClose}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon className="size-4" />
            </Button>
          )}
        </TitleBar>
        {/* session container */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* session content */}
          <div className="relative flex-1" ref={contentRef}>
            <MessageScrollerProvider
              autoScroll
              defaultScrollPosition="start"
              scrollPreviousItemPeek={64}
            >
              <div className="absolute inset-0 touch-pan-y overflow-y-auto bg-transparent">
                <div
                  className={cn(
                    "relative size-full mx-auto flex min-h-full min-w-0 w-full flex-col",
                    hasOutline && "@min-[1100px]:ps-[104px]"
                  )}
                >
                  <MessageScroller>
                    <MessageScrollerViewport>
                      <MessageScrollerContent className="px-0 py-4 max-w-[calc(56rem+16px)] mx-auto">
                        {turns.length === 0 ? (
                          <Empty className="h-full">
                            <EmptyHeader>
                              <EmptyMedia variant="icon">
                                <MessageSquareIcon />
                              </EmptyMedia>
                              {/* A read-only page has just been pointed at a
                                  child that has written nothing yet, which is
                                  not the same invitation to type. */}
                              <EmptyTitle>
                                {readOnly ? "Nothing yet" : "Start a session"}
                              </EmptyTitle>
                              <EmptyDescription>
                                {readOnly
                                  ? "This subagent has not written anything yet."
                                  : "Messages will appear here as the session progresses."}
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
                </div>
              </div>
              {hasOutline && (
                <div
                  className="absolute inset-y-0 start-0 hidden w-26 @min-[1100px]:block"
                  onWheel={(event) => {
                    // 条目多时先让大纲自己滚；还有余量就交回聊天记录。
                    const list = event.currentTarget.querySelector<HTMLElement>(
                      "[data-proximity-list]"
                    );
                    if (
                      event.target instanceof Node &&
                      list?.contains(event.target) &&
                      list.scrollHeight > list.clientHeight
                    ) {
                      return;
                    }

                    contentRef.current
                      ?.querySelector<HTMLElement>(
                        '[data-slot="message-scroller-viewport"]'
                      )
                      ?.scrollBy({ top: event.deltaY });
                  }}
                >
                  <SessionOutline sections={outlineSections} />
                </div>
              )}
            </MessageScrollerProvider>
          </div>

          {/* session input */}
          {!readOnly && (
            <div
              className={cn(
                "sticky bottom-0 z-1 w-full",
                hasOutline && "@min-[1100px]:ps-[104px]"
              )}
            >
              <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 border-t-0 pt-1 px-4 pb-4">
                <InboxDock
                  busy={isGenerating}
                  messages={pendingMessages}
                  onCancel={handleQueueCancel}
                  onClear={handleQueueClear}
                  onSend={handleQueueSend}
                />
                <PromptInputProvider>
                  {pendingQuestionnaire ? (
                    <QuestionnaireComposer
                      part={pendingQuestionnaire}
                      onRespond={handleRespondToolApproval}
                    />
                  ) : (
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
                          <ProjectSelect
                            locked={isProjectLocked}
                            onProjectChange={setSelectedProjectId}
                            projectId={selectedProjectId}
                            projects={projects}
                          />
                          <ModelSelect
                            models={models}
                            modelId={selectedModelId}
                            modelEffort={selectedModelEffort}
                            onModelChange={handleModelChange}
                            onModelEffortChange={handleModelEffortChange}
                          />
                        </PromptInputTools>
                        <div className="flex items-center gap-2">
                          {isGenerating && (
                            <ButtonGroup>
                              <Button
                                onClick={() => handleBusyModeChange("steering")}
                                size="xs"
                                type="button"
                                variant={
                                  busyMode === "steering"
                                    ? "secondary"
                                    : "ghost"
                                }
                              >
                                {t("composer.mode.steering")}
                              </Button>
                              <Button
                                onClick={() => handleBusyModeChange("followup")}
                                size="xs"
                                type="button"
                                variant={
                                  busyMode === "followup"
                                    ? "secondary"
                                    : "ghost"
                                }
                              >
                                {t("composer.mode.followup")}
                              </Button>
                            </ButtonGroup>
                          )}
                          <Context
                            maxTokens={contextWindow}
                            modelId={selectedModelId}
                            usage={tokenUsage}
                            usedTokens={contextUsedTokens}
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
                          {isGenerating && (
                            <PromptInputStop onStop={() => void stop()} />
                          )}
                          <PromptInputSubmit
                            disabled={isEditorEmpty || !selectedModelId}
                            label={submitLabel}
                            status={status}
                          />
                        </div>
                      </PromptInputFooter>
                    </PromptInput>
                  )}
                </PromptInputProvider>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
