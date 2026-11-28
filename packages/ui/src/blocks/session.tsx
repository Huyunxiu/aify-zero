import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_BOT_ID,
  generateSessionId,
  generateStepId,
  generateTurnId,
} from "@workspace/agent-client";
import type {
  AgentToolSet,
  AgentStreamEvent,
  AgentUserPart,
  AgentUserTurn,
  ApprovalPolicy,
} from "@workspace/agent-client";
import type { ForkSessionType } from "@workspace/server/routers/session/session.schema";
import { LOCAL_STORAGE_KEYS, ModelEffort } from "@workspace/shared/constants";
import { getErrorMessage } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";
import type { ModelRef } from "@workspace/shared/model";
import { BotAvatar } from "@workspace/ui/blocks/bot-avatar";
import type { LanguageModelUsage } from "ai";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  PanelRightIcon,
} from "lucide-react";
import * as React from "react";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "../blocks/attachments";
import type { ToolApprovalAnswer } from "../blocks/chain-of-turn";
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
} from "../blocks/token-context";
import { Button } from "../components/button";
import { ButtonGroup } from "../components/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/resizable";
import { toastManager } from "../components/toast";
import { useAgentSession } from "../hooks/use-agent-session";
import type { SubmitMode } from "../hooks/use-agent-session";
import { useSubagentAddress } from "../hooks/use-subagent-address";
import { DEFAULT_LANG, isLang } from "../i18n";
import { approvalPolicyTarget } from "../lib/approval-policy-target";
import { flattenModels, parseModelRef, sameModel } from "../lib/models";
import { client, queryClient } from "../lib/orpc";
import {
  orpcSessionTransport,
  sessionTurnsQueryKey,
} from "../lib/session-orpc-transport";
import { buildSessionOutline } from "../lib/session-outline";
import type { SessionOutlineSection } from "../lib/session-outline";
import { findSubagentTitle } from "../lib/subagent-call";
import { cn } from "../lib/utils";
import { ApprovalPolicySelect } from "./approval-policy-select";
import { InboxDock } from "./inbox-dock";
import { FileLinkProvider } from "./markdown-link";
import type { FileOpenTarget } from "./markdown-link";
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
import { SESSION_COLUMN } from "./session-column";
import { SessionPanel } from "./session-panel/session-panel";
import { TitleBar } from "./title-bar";
import { Transcript } from "./transcript/transcript";
import type { TranscriptEmpty } from "./transcript/transcript";

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

/** What a session with no turn yet says. */
const EMPTY_SESSION: TranscriptEmpty = {
  description: "Messages will appear here as the session progresses.",
  title: "Start a session",
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
  /** Pre-selected Bot for an unsaved session; existing session row always wins. */
  initialBotId?: string;
  /**
   * 新建会话时预选的项目。
   *
   * 只作为初始值。会话行一旦存在，行上的项目就是唯一事实源；首次落库后
   * 不能再改，否则后续回合会跑到别的目录。
   */
  initialProjectId?: string;
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
   * Whether an opaque layer stands between the reader and this session.
   *
   * A covered session keeps streaming and keeps its draft. It is only not read:
   * a turn that ends behind a covering route is still unseen, so its notice
   * still fires. See ADR 0020.
   */
  covered: boolean;
};

export function Session({
  sessionId,
  initialBotId,
  initialProjectId,
  questionnairePlacement = "composer",
  covered,
}: SessionProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const lang = isLang(i18n.language) ? i18n.language : DEFAULT_LANG;

  const getSettingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
  });

  // A turn outlives the page that asked for it, so a page entering a session
  // asks what that session is up to rather than assuming it is idle.
  const getSessionQuery = useQuery({
    queryKey: ["getSession", sessionId],
    queryFn: async () =>
      await client.session.getSession({ sessionId: sessionId ?? "" }),
    enabled: Boolean(sessionId),
  });

  const effectiveBotId =
    getSessionQuery.data?.session?.botId ?? initialBotId ?? DEFAULT_BOT_ID;

  const getBotQuery = useQuery({
    queryKey: ["bot", effectiveBotId],
    queryFn: async () => await client.bot.get({ botId: effectiveBotId }),
  });
  const activeBot = getBotQuery.data?.bot;

  // Same query key as the sidebar, so creating a project there makes it
  // selectable here without another round trip.
  const listProjectsQuery = useQuery({
    queryKey: ["list_projects"],
    queryFn: () => client.project.list(),
  });

  // 会话标题：顶层会话是生成标题，子会话是 `task` 调用交给它的任务简述。
  // 侧边栏收起后，标题栏是唯一还能看到它的地方。
  const sessionTitle = getSessionQuery.data?.session?.title;

  const forkSessionMutation = useMutation({
    mutationFn: async (options: ForkSessionType) =>
      await client.session.forkSession(options),
    onSuccess: async ({ sessionId: forkSessionId }) => {
      await queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
      await navigate({ to: `/sessions/${forkSessionId}` });
    },
  });

  const models = React.useMemo(
    () => flattenModels(getSettingsQuery.data?.providers ?? []),
    [getSettingsQuery.data?.providers]
  );
  const [selectedModel, setSelectedModel] = React.useState<
    ModelRef | undefined
  >(() => parseModelRef(localStorage.getItem(LOCAL_STORAGE_KEYS.MODEL_ID)));
  const selectedModelOption = React.useMemo(
    () => models.find((option) => sameModel(option.ref, selectedModel)),
    [models, selectedModel]
  );
  const [selectedModelEffort, setSelectedModelEffort] = React.useState<
    ModelEffort | undefined
  >(() => {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEYS.MODEL_EFFORT);
    return stored && Object.values(ModelEffort).includes(stored as ModelEffort)
      ? (stored as ModelEffort)
      : "default";
  });
  const [userPickedModel, setUserPickedModel] = React.useState(false);
  const modelSeededRef = React.useRef(false);

  const missingBotModel =
    !userPickedModel &&
    getSettingsQuery.isSuccess &&
    activeBot?.defaultModel !== undefined &&
    activeBot.defaultModel !== null &&
    !models.some((option) =>
      sameModel(option.ref, activeBot.defaultModel ?? undefined)
    )
      ? activeBot.defaultModel
      : undefined;

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

  // 面板默认收起：它是辅助视图，不该一直挤占会话宽度。
  const [panelOpen, setPanelOpen] = React.useState(false);
  // 聊天里文件链接要打开的目标；每点一次换一个新对象，重复点同一个也会重放。
  const [fileOpenRequest, setFileOpenRequest] =
    React.useState<FileOpenTarget>();
  const panelRef = usePanelRef();

  // 文件链接：展开面板，再把请求交给面板。会话还没有 id 时面板不存在，
  // 链接点不动就好。
  const openFileInPanel = React.useCallback(
    (target: FileOpenTarget) => {
      if (!sessionId) {
        return;
      }

      setFileOpenRequest(target);
      setPanelOpen(true);
    },
    [sessionId]
  );

  const handleModelChange = (next: ModelRef) => {
    setUserPickedModel(true);
    localStorage.setItem(LOCAL_STORAGE_KEYS.MODEL_ID, JSON.stringify(next));
    setSelectedModel(next);
  };

  const handleModelEffortChange = (effort: ModelEffort) => {
    setUserPickedModel(true);
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
  const projectSeededRef = React.useRef(initialProjectId !== undefined);

  const handleProjectChange = (next: string | undefined) => {
    projectSeededRef.current = true;
    setSelectedProjectId(next);
  };

  const listSessionResourcesQuery = useQuery({
    queryKey: [
      "listSessionResources",
      sessionId,
      effectiveBotId,
      selectedProjectId,
    ],
    queryFn: async () =>
      await client.session.listSessionResources({
        sessionId: sessionId ?? "",
        botId: effectiveBotId,
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
      }),
  });

  // An existing session's row is the source of truth: `session.create` writes
  // the project on insert only, so a reloaded page has to read it back from
  // there to keep showing the directories the session runs in. A new session
  // has no row yet, so the project picked in the sidebar stays selected.
  const sessionProjectId =
    getSessionQuery.data?.session?.projectId ?? undefined;

  React.useEffect(() => {
    if (getSessionQuery.data?.session) {
      projectSeededRef.current = true;
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

  // The policy differs from the project: a change is allowed mid-session, and it applies to
  // the next Run. The row wins when the page opens; a new session has no row, so it keeps the default until the first message.
  const [approvalPolicy, setApprovalPolicy] = React.useState<ApprovalPolicy>(
    DEFAULT_APPROVAL_POLICY
  );
  // The home route has no session id, but the row exists after the first message is stored.
  // Use state, not a ref: the write triggers a render, so the policy reaches that row and does not wait for a refresh.
  const [rowSaved, setRowSaved] = React.useState(false);
  const policySeededRef = React.useRef(false);
  const sessionApprovalPolicy = getSessionQuery.data?.session?.approvalPolicy;
  const sessionRowReady = !sessionId || getSessionQuery.isFetched;

  React.useEffect(() => {
    if (
      !sessionRowReady ||
      getSessionQuery.data?.session ||
      !activeBot ||
      activeBot.id !== effectiveBotId
    ) {
      return;
    }

    if (!projectSeededRef.current && initialProjectId === undefined) {
      projectSeededRef.current = true;
      setSelectedProjectId(activeBot.defaultProjectId ?? undefined);
    }

    if (!policySeededRef.current && !rowSaved) {
      policySeededRef.current = true;
      setApprovalPolicy(activeBot.defaultApprovalPolicy);
    }

    if (
      !userPickedModel &&
      !rowSaved &&
      !modelSeededRef.current &&
      getSettingsQuery.isSuccess
    ) {
      if (activeBot.defaultModel !== null) {
        const available = models.some((option) =>
          sameModel(option.ref, activeBot.defaultModel ?? undefined)
        );
        setSelectedModel(available ? activeBot.defaultModel : undefined);
        if (available) {
          if (activeBot.defaultEffort) {
            setSelectedModelEffort(activeBot.defaultEffort);
          }
          modelSeededRef.current = true;
        }
      } else {
        modelSeededRef.current = true;
      }
    }
  }, [
    activeBot,
    effectiveBotId,
    getSessionQuery.data?.session,
    getSettingsQuery.isSuccess,
    initialProjectId,
    models,
    rowSaved,
    sessionRowReady,
    userPickedModel,
  ]);

  // Fallback for active model selection once Bot model seeding has settled (unless blocked by a missing Bot defaultModel).
  React.useEffect(() => {
    if (
      missingBotModel ||
      !sessionRowReady ||
      (!getSessionQuery.data?.session &&
        !rowSaved &&
        !userPickedModel &&
        !modelSeededRef.current) ||
      models.length === 0 ||
      models.some((option) => sameModel(option.ref, selectedModel))
    ) {
      return;
    }
    const preferred = getSettingsQuery.data?.defaultModel;
    const fallback = models.find((option) =>
      sameModel(option.ref, preferred ?? undefined)
    );
    setSelectedModel(fallback?.ref ?? models[0]!.ref);
  }, [
    activeBot?.defaultModel,
    activeBot?.id,
    getSessionQuery.data?.session,
    getSettingsQuery.data?.defaultModel,
    missingBotModel,
    models,
    rowSaved,
    selectedModel,
    sessionRowReady,
    userPickedModel,
  ]);

  React.useEffect(() => {
    const saved = APPROVAL_POLICIES.find(
      (policy) => policy === sessionApprovalPolicy
    );
    if (saved) {
      policySeededRef.current = true;
      setApprovalPolicy(saved);
    }
  }, [sessionApprovalPolicy]);

  const policyTarget = approvalPolicyTarget({
    sessionId,
    sessionKey,
    rowSaved,
  });

  const handleApprovalPolicyChange = React.useCallback(
    (next: ApprovalPolicy) => {
      policySeededRef.current = true;
      setApprovalPolicy(next);
      // Send no request while the row does not exist: the first message carries the policy with it.
      if (!policyTarget) {
        return;
      }

      void client.session
        .setApprovalPolicy({ sessionId: policyTarget, approvalPolicy: next })
        .then(() =>
          // This rereads the query that the page reads: the home route does not enable it, so
          // the local state already holds the user choice, and the next mount takes the row.
          queryClient.invalidateQueries({
            queryKey: ["getSession", sessionId],
          })
        )
        .catch((error: unknown) => {
          logger.warn("[approval-policy] failed to save the policy", error);
        });
    },
    [policyTarget, sessionId]
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
    hydrated,
    submit,
    sendPending,
    cancelPending,
    clearPending,
    error: sessionError,
    status,
    stop,
    addToolApprovalResponse,
  } = useAgentSession({
    id: sessionKey,
    transport: orpcSessionTransport,
    hydrate: sessionId !== undefined,
    onEvent,
  });

  // Sync panel collapse state once hydrated mounts the ResizablePanel.
  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    if (panelOpen) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [panelOpen, panelRef, hydrated]);

  // The held questionnaire whose form belongs in the composer's slot. Reading
  // it from the transcript rather than from the last event keeps the placement
  // honest across reloads and resumptions: a page that attaches to a held turn
  // still offers the form, and one that attaches after it was answered does
  // not. Inline placement leaves the form to the transcript.
  const pendingQuestionnaire = React.useMemo(
    () =>
      questionnairePlacement !== "composer"
        ? undefined
        : findPendingQuestionnaire(turns),
    [turns, questionnairePlacement]
  );

  // The subagent the address names. It is the reader's standing choice, not the
  // active tab, so the panel builds that tab when it mounts.
  const subagentAddress = useSubagentAddress();
  const namedSubagentSessionId = subagentAddress.selectedSubagentSessionId;

  // The description that the `task` call wrote is also the title of that
  // session, so naming the tab costs no request. It is only a name: the choice
  // stands without it, because the address holds the choice and the record may
  // arrive after it.
  const namedSubagentTitle = React.useMemo(
    () =>
      namedSubagentSessionId === undefined
        ? undefined
        : findSubagentTitle(turns, namedSubagentSessionId),
    [namedSubagentSessionId, turns]
  );

  const namedSubagent = React.useMemo(
    () =>
      namedSubagentSessionId === undefined
        ? undefined
        : {
            sessionId: namedSubagentSessionId,
            ...(namedSubagentTitle === undefined
              ? {}
              : { title: namedSubagentTitle }),
          },
    [namedSubagentSessionId, namedSubagentTitle]
  );

  // A selection the panel cannot show is a dead one: the address names a
  // subagent, so the panel opens. Closing that tab is what takes the choice back.
  React.useEffect(() => {
    if (namedSubagent !== undefined) {
      setPanelOpen(true);
    }
  }, [namedSubagent]);

  // 看得见才算读过。回合跑完会把会话留成 `done`（侧栏那个勾），打开着的
  // 页面负责把它抹掉：到达时一次，看着的回合走回 `ready` 时再一次。
  //
  // 窗口收进托盘只是 hide，页面还在、状态照样走回 `ready`，但那一刻没人
  // 看得见屏幕。这时标记已读，发件箱就会以为有人看着，本该在关窗后落定的
  // 系统通知永远不弹。所以隐藏时不标记，回到前台再补。
  React.useEffect(() => {
    if (!sessionId || !hydrated) {
      return;
    }

    const id = sessionId;

    const settle = (): void => {
      if (status !== "ready") {
        return;
      }

      void (async () => {
        try {
          // A covered session is on screen but unseen: the reader looks at the
          // route above it. Leaving it unread is what makes its notice fire.
          if (!covered && document.visibilityState === "visible") {
            await client.session.markSessionRead({ sessionId: id });
          }

          // The sidebar shows the last activity and the unread tick. Both change
          // when a turn settles, whether or not this page is the one looking.
          await queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
        } catch {
          // 标记已读是记账，不是页面的正事：链接坏了，会话记录照样显示，只是
          // 那个勾留着。
        }
      })();
    };

    settle();
    document.addEventListener("visibilitychange", settle);

    return () => {
      document.removeEventListener("visibilitychange", settle);
    };
  }, [sessionId, status, covered, hydrated]);

  // Invalidate `listSessionTurns` and `list_sessions` when a run settles so a
  // later session remount hydrates from fresh persisted turns instead of stale
  // cache, and failed runs update sidebar unread/last-activity state.
  const previousStatus = React.useRef(status);

  React.useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = status;

    const wasRunning = previous === "submitted" || previous === "streaming";

    // 只认收尾：`submitted → streaming` 是运行开始，不是落定。
    if (!wasRunning || status === "streaming") {
      return;
    }

    if (sessionId) {
      void queryClient.invalidateQueries({
        queryKey: sessionTurnsQueryKey(sessionId),
      });
    }

    if (status === "error") {
      void queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
    }
  }, [sessionId, status]);

  const finalError =
    sessionError ?? turns.findLast((turn) => turn.status === "error")?.error;

  // 大纲把会话记录压成「一问一节」。答复在流式输出时文字一直在变；按轮次 id、
  // 状态和语言命中缓存，只在答复落定时重取一次，侧边栏不跟着每个 token 重建。
  //
  // 滚动锚点仍然只给用户轮次：MessageScroller 用锚点决定新内容的落点，
  // 把答复也标成锚点会让每段答复都往视口顶上跳。
  const outlineCacheRef = React.useRef<{
    key: string;
    sections: SessionOutlineSection[];
  }>({ key: "", sections: [] });

  const outlineSections = React.useMemo(() => {
    const key = `${lang}|${turns
      .map((turn) => `${turn.id}:${turn.type}:${turn.status}`)
      .join("|")}`;

    if (outlineCacheRef.current.key === key) {
      return outlineCacheRef.current.sections;
    }

    const sections = buildSessionOutline(turns, Date.now(), lang);

    outlineCacheRef.current = { key, sections };
    return sections;
  }, [turns, lang]);

  // 每个用户轮次都是一个滚动锚点；节只是其中一部分，活动标记靠锚点序号对齐。
  const outlineAnchors = React.useMemo(
    () => turns.filter((turn) => turn.type === "user").map((turn) => turn.id),
    [turns]
  );

  // 只有一个提问也显示：长答复里可以从底部一下跳回提问。
  const hasOutline = outlineSections.length > 0;

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

  const configuredContextWindow = selectedModelOption?.context;
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
   * 触发一次压缩。
   *
   * 服务端只负责开始：摘要本身在后台跑，压缩事件从本页已经挂着的事件流上
   * 过来，压缩 turn 也照常落进会话记录。这里说完就结束。
   */
  const handleCompact = async (model: ModelRef): Promise<void> => {
    if (!sessionId) {
      toastManager.add({
        description: t("compaction.noSession"),
        title: t("compaction.failed"),
        type: "error",
      });
      return;
    }

    try {
      await client.session.compactSession({
        model,
        sessionId,
      });
    } catch (error) {
      // Refused synchronously — busy session, or nothing to compact.
      toastManager.add({
        description: getErrorMessage(error),
        title: t("compaction.failed"),
        type: "error",
      });
      return;
    }

    // 标记已经进了 branch：刷新会话行和缓存的 branch，重新挂载时看到的就是
    // 记录里那一条。
    void queryClient.invalidateQueries({
      queryKey: sessionTurnsQueryKey(sessionId),
    });
    void queryClient.invalidateQueries({
      queryKey: ["getSession", sessionId],
    });
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const model = selectedModel;
    if (!model) {
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
      void handleCompact(model);
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

    const isFirstTurn = turns.length === 0;

    try {
      // 新会话直接发送；已有会话先入队，再按顺序 drain。空闲时 mode 不参与。
      await submit({
        turn,
        mode: isGenerating ? busyMode : undefined,
        payload: {
          model,
          modelEffort: selectedModelEffort,
          botId: effectiveBotId,
          projectId:
            projectSeededRef.current || selectedProjectId !== undefined
              ? (selectedProjectId ?? null)
              : undefined,
          approvalPolicy,
        },
      });
      setRowSaved(true);
      // Refresh the sidebar once `submit` confirms the session row exists on the server.
      if (isFirstTurn) {
        void queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
      }
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

  const handleQueueCancel = (itemId: string) => {
    void cancelPending(itemId).catch(reportQueueError);
  };

  const handleQueueClear = () => {
    void clearPending().catch(reportQueueError);
  };

  const handleRespondToolApproval = React.useCallback(
    (approvalId: string, approved: boolean, answer?: ToolApprovalAnswer) => {
      if (!selectedModel) {
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
          model: selectedModel,
          modelEffort: selectedModelEffort,
          projectId: selectedProjectId,
        },
      });
    },
    [
      addToolApprovalResponse,
      selectedModel,
      selectedModelEffort,
      selectedProjectId,
    ]
  );

  if (!hydrated) {
    return null;
  }

  return (
    <FileLinkProvider openFile={openFileInPanel}>
      <div className="relative h-full">
        <ResizablePanelGroup
          className="overflow-hidden"
          orientation="horizontal"
        >
          <ResizablePanel>
            <div className="@container flex h-full min-w-0 flex-col">
              {/* session header */}
              <TitleBar className="sticky top-0 flex h-12 items-center gap-2 px-4">
                {activeBot ? (
                  <button
                    type="button"
                    onClick={() => {
                      void navigate({
                        to: "/bots/$botId",
                        params: { botId: activeBot.id },
                      });
                    }}
                    className="[-webkit-app-region:no-drag] inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground active:scale-[0.97] transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none motion-reduce:transform-none"
                  >
                    <BotAvatar
                      avatarPath={activeBot.avatarPath}
                      botId={activeBot.id}
                      name={activeBot.name}
                      version={activeBot.updatedAt}
                      size="sm"
                    />
                    <span className="max-w-32 truncate">{activeBot.name}</span>
                  </button>
                ) : null}
                {sessionId && (
                  <div className="min-w-0 truncate text-foreground text-sm max-w-md">
                    {sessionTitle || t("sessions.untitled")}
                  </div>
                )}
              </TitleBar>
              {/* session container */}
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="min-h-0 flex-1">
                  <Transcript
                    bot={activeBot}
                    empty={EMPTY_SESSION}
                    error={finalError}
                    onFork={(messageId) => {
                      if (sessionId) {
                        forkSessionMutation.mutate({ sessionId, messageId });
                      }
                    }}
                    onRespondToolApproval={handleRespondToolApproval}
                    outline={
                      hasOutline
                        ? { anchors: outlineAnchors, sections: outlineSections }
                        : undefined
                    }
                    questionnairePlacement={questionnairePlacement}
                    turns={turns}
                  />
                </div>

                {/* session input */}
                <div className="sticky bottom-0 z-1 w-full">
                  {/* The bar's width comes out of the record's box, so the
                      input box reserves the same on both sides; the two
                      blocks then center on one axis. */}
                  <div className="px-[var(--scrollbar-size)]">
                    <div
                      className={cn(
                        SESSION_COLUMN,
                        "gap-2 border-t-0 pt-1 pb-4"
                      )}
                    >
                      {missingBotModel ? (
                        <div
                          className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 text-xs dark:text-amber-200"
                          role="alert"
                        >
                          <div className="flex items-center gap-2">
                            <AlertTriangleIcon className="size-4 shrink-0" />
                            <span>
                              {t("bots.model.missingWarning", {
                                model: `${missingBotModel.providerId}/${missingBotModel.modelId}`,
                              })}
                            </span>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                              void navigate({
                                to: "/bots/$botId",
                                params: { botId: effectiveBotId },
                              });
                            }}
                          >
                            {t("bots.actions.configure")}
                          </Button>
                        </div>
                      ) : null}
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
                                  listSessionResourcesQuery.data?.skills.map(
                                    (e) => ({
                                      ...e,
                                      type: "skill",
                                    })
                                  ) || []
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
                              <PromptInputTools className="flex-wrap gap-0">
                                <PromptInputActionMenu>
                                  <PromptInputActionMenuTrigger />
                                  <PromptInputActionMenuContent className="min-w-max">
                                    <PromptInputActionAddAttachments
                                      disabled={
                                        !selectedModelOption?.acceptsImage
                                      }
                                    />
                                  </PromptInputActionMenuContent>
                                </PromptInputActionMenu>
                                <ProjectSelect
                                  locked={isProjectLocked}
                                  onProjectChange={handleProjectChange}
                                  projectId={selectedProjectId}
                                  projects={projects}
                                />
                                <ModelSelect
                                  models={models}
                                  model={selectedModel}
                                  modelEffort={selectedModelEffort}
                                  onModelChange={handleModelChange}
                                  onModelEffortChange={handleModelEffortChange}
                                />
                                <ApprovalPolicySelect
                                  approvalPolicy={approvalPolicy}
                                  onApprovalPolicyChange={
                                    handleApprovalPolicyChange
                                  }
                                />
                              </PromptInputTools>
                              <div className="flex items-center gap-2">
                                {isGenerating && (
                                  <ButtonGroup>
                                    <Button
                                      onClick={() =>
                                        handleBusyModeChange("steering")
                                      }
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
                                      onClick={() =>
                                        handleBusyModeChange("followup")
                                      }
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
                                  modelId={selectedModelOption?.name}
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
                                  <div className="flex items-center">
                                    <PromptInputStop
                                      onStop={() => void stop()}
                                    />
                                    <DropdownMenu>
                                      <DropdownMenuTrigger
                                        render={
                                          <Button
                                            aria-label={t(
                                              "composer.stop.options"
                                            )}
                                            className="-ml-px rounded-l-none"
                                            size="icon-sm"
                                            type="button"
                                            variant="outline"
                                          />
                                        }
                                      >
                                        <ChevronDownIcon className="size-4" />
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem
                                          onClick={() => void stop()}
                                        >
                                          {t("composer.stop.everything")}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          onClick={() =>
                                            void stop({ keepSubagents: true })
                                          }
                                        >
                                          {t("composer.stop.replyOnly")}
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </div>
                                )}
                                <PromptInputSubmit
                                  disabled={isEditorEmpty || !selectedModel}
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
                </div>
              </div>
            </div>
          </ResizablePanel>
          {sessionId && (
            <>
              <ResizableHandle
                className={panelOpen ? undefined : "hidden"}
                variant="gutter"
              />
              <ResizablePanel
                collapsedSize={0}
                collapsible
                defaultSize="50%"
                id="session-panel"
                maxSize="80%"
                minSize="50%"
                panelRef={panelRef}
              >
                {/* 收起时只折叠，不卸载：里面的状态要留到下次打开。 */}
                <div className="h-full" inert={!panelOpen}>
                  <SessionPanel
                    bot={activeBot}
                    key={sessionId}
                    onClose={() => setPanelOpen(false)}
                    onSubagentDropped={(droppedSessionId) => {
                      // The tab is gone, so the address must stop naming it;
                      // otherwise a reload brings back a tab just closed.
                      if (droppedSessionId === namedSubagentSessionId) {
                        subagentAddress.clear();
                      }
                    }}
                    open={panelOpen}
                    openRequest={fileOpenRequest}
                    sessionId={sessionId}
                    subagentRequest={namedSubagent}
                  />
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
        {/* 入口按钮钉在会话框右上角，放在动画区外：聊天栏宽度随面板展开/收起
          变化，按钮在栏内会跟着滑动；这里任何状态下位置都不变。 */}
        {sessionId && !panelOpen && (
          <div className="absolute top-0 right-4 z-10 flex h-12 items-center [-webkit-app-region:no-drag]">
            <Button
              aria-label={t("panel.tabs.files")}
              onClick={() => setPanelOpen(true)}
              size="icon-sm"
              variant="ghost"
            >
              <PanelRightIcon className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </FileLinkProvider>
  );
}
