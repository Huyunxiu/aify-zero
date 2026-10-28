import { mkdirSync } from "node:fs";

import { streamToEventIterator, type } from "@orpc/server";
import {
  createBashTool,
  createJobTools,
  createReadFileTool,
  createWriteFileTool,
  createDeleteFileTool,
  createEditFileTool,
  createGrepTool,
  createGlobTool,
  createWebFetchTool,
  createTaskTool,
  createQuestionnaireTool,
  createPowerShellTool,
  Agent,
  AgentInbox,
  appendSubagentPrompt,
  ContextExtension,
  EnvironmentExtension,
  FileSystemContextSource,
  FileSystemSkillSource,
  InboxMessageNotFoundError,
  loadContextFiles,
  NothingToCompactError,
  resolvePolicy,
  SkillExtension,
  STREAM_REGISTRY,
  SUBAGENT_DEFINITIONS,
} from "@workspace/agent";
import type { AgentToolSet } from "@workspace/agent";
import {
  addToolApprovalResponse,
  findToolApprovalRequests,
  findTurnWithoutToolResult,
} from "@workspace/agent-client";
import type {
  AgentStep,
  AgentTurn,
  AgentUserTurn,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import { AgentContext } from "@workspace/agent/agent-context";
import { AgentSession } from "@workspace/agent/agent-session";
import { SKILL_DIRS, SkillManager } from "@workspace/agent/skill/index";
import type { TurnWrite } from "@workspace/agent/storage/index";
import { SQLiteStore } from "@workspace/agent/storage/sqlite-store";
import { createLoadSkillTool } from "@workspace/agent/tools/load-skill";
import {
  defaultBashShell,
  defaultPowerShell,
} from "@workspace/agent/tools/shell/resolve";
import {
  generateSessionId,
  generateStepId,
  generateTurnId,
} from "@workspace/agent/utils/id-util";
import { ModelEffort } from "@workspace/shared/constants";
import { logger } from "@workspace/shared/logger";
import type { ToolSet } from "ai";
import z from "zod";

import { getSessionDir } from "../config";
import { ApiError, ErrorMap } from "../errors";
import { publicProcedure } from "../index";
import { JOB_REGISTRY } from "../jobs";
import { withSessionLock } from "../session-lock";
import {
  getPrimaryProjectDir,
  getProjectDirs,
} from "./project/project.service";
import {
  forkSessionSchema,
  inboxMessageIdSchema,
  listSessionTurnsSchema,
  resolveInboxPlacement,
} from "./session.schema";
import type { InboxMode } from "./session.schema";
import type { AiModel } from "./settings/settings.schema";
import { findAiModelById, getUserSettings } from "./settings/settings.service";

/**
 * 建一个会话用的 agent：目录、策略、扩展和工具都按这个会话装配好。
 *
 * 建回合和手工压缩都要同一套装配；差别只在 AgentSession 里有什么、以及
 * 接下来调用 `stream` 时发哪种 signal。
 */
async function buildSessionAgent({
  sessionId,
  aiModel,
  effort,
  projectId,
  session,
  store,
}: {
  sessionId: string;
  aiModel: AiModel;
  effort?: ModelEffort;
  projectId?: string;
  session: AgentSession;
  store: SQLiteStore;
}): Promise<Agent> {
  // 会话目录先建出来：Environment 提示会把路径告诉模型，模型可能直接往里
  // 写文件，不该让它先自己 mkdir。
  const sessionDir = getSessionDir(sessionId);
  mkdirSync(sessionDir, { recursive: true });

  // 目录来自 project 表：会话指定了项目就用那个项目，否则用默认项目。
  const projectDirs = await getProjectDirs(projectId);

  // 技能和上下文由扩展加载并持有；提示词由扩展注册的片段在 turn 开始时
  // 统一拼接，宿主只负责把资源注册进去。
  const settings = await getUserSettings();
  const compaction = resolvePolicy({
    contextWindow: aiModel.limit?.context,
    overrides: settings.compaction,
  });
  const modelContextWindows = Object.fromEntries(
    settings.models
      .filter((configured) => (configured.limit?.context ?? 0) > 0)
      .map((configured) => [configured.model, configured.limit?.context ?? 0])
  );
  const agentContext = new AgentContext({
    sessionId,
    projectDirs,
    sessionDir,
    projectId,
    modelId: aiModel.model,
    modelEffort: effort,
    compaction,
    modelContextWindows,
    jobs: JOB_REGISTRY,
  });

  const tools: ToolSet = {
    "read-file": createReadFileTool({ agentContext }),
    "write-file": createWriteFileTool({ agentContext }),
    "delete-file": createDeleteFileTool({ agentContext }),
    "edit-file": createEditFileTool({ agentContext }),
    grep: createGrepTool({ agentContext }),
    glob: createGlobTool({ agentContext }),
    "web-fetch": createWebFetchTool({ agentContext }),
    "load-skill": createLoadSkillTool({ agentContext }),
  };
  // 任务控制工具跟着注册表走：没有注册表就没有后台任务可控制，模型也就不该
  // 看见这三个工具。
  if (agentContext.jobs !== undefined) {
    Object.assign(tools, createJobTools({ agentContext }));
  }
  // The shell tool follows the host: POSIX always has bash; Windows gets
  // PowerShell, plus bash when Git Bash is installed. A tool whose executable
  // cannot be resolved is left out rather than advertised and failing later.
  if (defaultBashShell() !== undefined) {
    tools.bash = createBashTool({ agentContext });
  }
  if (defaultPowerShell() !== undefined) {
    tools.powershell = createPowerShellTool({ agentContext });
  }

  const agent = new Agent({
    name: "main",
    sessionId,
    modelEffort: effort,
    context: agentContext,
    session,
    tools,
    store,
    apiKey: aiModel.apiKey,
    apiUrl: aiModel.apiUrl,
    providerId: aiModel.provider,
    modelId: aiModel.model,
  });

  // 环境信息排在最前：模型先知道自己在哪个项目、哪个会话目录里工作，
  // 再读项目说明和技能列表。
  await agent.registerExtension(
    new EnvironmentExtension({ id: "environment" })
  );

  const skillsExtension = new SkillExtension({
    id: "filesystem-skills",
    sources: [new FileSystemSkillSource()],
  });
  await agent.registerExtension(skillsExtension);
  await agent.registerExtension(
    new ContextExtension({
      id: "filesystem-context",
      sources: [new FileSystemContextSource()],
    })
  );

  // 系统提示由扩展注册的片段生成；`load-skill` 工具需要按名字查技能，
  // 所以这里把扩展持有的 manager 交给上下文。
  agentContext.skills = skillsExtension.manager;
  agent.systemPrompt = appendSubagentPrompt("");

  agent.registerTool(
    "task",
    createTaskTool({
      agent,
      agentContext,
      definitions: SUBAGENT_DEFINITIONS,
    })
  );

  agent.registerTool("questionnaire", createQuestionnaireTool({ agent }));

  return agent;
}

const createSession = publicProcedure
  .route({ method: "POST", path: "/sessions" })
  .errors({
    MODEL_NOT_FOUND: ErrorMap.MODEL_NOT_FOUND,
    PROJECT_NOT_FOUND: ErrorMap.PROJECT_NOT_FOUND,
    SESSION_BUSY: ErrorMap.SESSION_BUSY,
    INBOX_MESSAGE_NOT_FOUND: ErrorMap.INBOX_MESSAGE_NOT_FOUND,
  })
  .input(
    type<{
      sessionId: string;
      turns: AgentTurn<AgentToolSet>[];
      approvals?: TextStreamToolApprovalResponseEvent[];
      model: string;
      modelEffort?: string;
      /**
       * 会话归属的项目；只在会话首次落库时生效，之后沿用行上已有的项目。
       * 省略时落一条没有项目归属的会话，目录退回默认项目。
       */
      projectId?: string;
      /**
       * 这条用户消息来自 Inbox 的哪一行。给了就要求认领和写入同一个事务，
       * 行不在了说明已被别的调用者领走。
       */
      inboxId?: string;
    }>()
  )
  .handler(async ({ input }) => {
    const {
      sessionId,
      turns,
      approvals,
      model,
      modelEffort,
      projectId,
      inboxId,
    } = input;

    const aiModel = await findAiModelById(model);
    if (!aiModel) {
      throw new ApiError("MODEL_NOT_FOUND", { data: { model } });
    }

    const effort = Object.values(ModelEffort).includes(
      modelEffort as ModelEffort
    )
      ? (modelEffort as ModelEffort)
      : undefined;

    const mostRecentTurn = turns.at(-1);
    // mostRecentTurn 和 approvals 至少要有一个
    if (!mostRecentTurn && !approvals?.length) {
      throw new Error("no message.");
    }

    return await withSessionLock(sessionId, async () => {
      const store = new SQLiteStore();
      const inbox = new AgentInbox(store);

      // 项目在会话行落库时固定：行已存在就沿用行上的项目，输入值只在首次
      // 落库时生效。否则刷新后还没读到会话行的发送会把目录退回默认项目。
      const previousSession = await store.getSessionById(sessionId);
      const sessionProjectId = previousSession
        ? (previousSession.projectId ?? undefined)
        : projectId;

      // 一条流没跑完之前不能再开一条：手工压缩现在也注册成流，在锁释放后
      // 继续跑，所以这里不能只靠锁来串行化。已经结束但还没从注册表摘掉的
      // 条目（审批恢复时常见）不算占用。
      const running = STREAM_REGISTRY.getStreamEntryBySession(sessionId);
      if (running && !running.isDone()) {
        throw new ApiError("SESSION_BUSY", {
          data: { sessionId, reason: "running" },
        });
      }

      const previousMessages = await store.getBranchTurns(sessionId, {
        activeStreamId: previousSession?.activeStreamId ?? undefined,
      });
      const previousTurns = AgentSession.toAgentTurns(previousMessages);
      const originalTurns = mostRecentTurn
        ? [...previousTurns, mostRecentTurn]
        : previousTurns;
      const session = new AgentSession({ turns: originalTurns });
      if (approvals?.length) {
        const changedTurns = addToolApprovalResponse(session.turns, approvals);
        for (const turn of changedTurns) {
          await store.updateTurn(turn.id, turn);
        }
        const toolParts = findToolApprovalRequests(session.turns);
        if (toolParts.length > 0) {
          return {
            activeStreamId: null,
            awaitingToolApprovals: toolParts.length,
          };
        }
      }

      const agent = await buildSessionAgent({
        sessionId,
        aiModel,
        effort,
        projectId: sessionProjectId,
        session,
        store,
      });

      const activeStreamId = generateSessionId();

      let stream: Awaited<ReturnType<Agent["stream"]>>;
      try {
        stream = await agent.stream({
          turns: originalTurns,
          modelId: aiModel.model,
          streamId: activeStreamId,
          signal: { type: "turn" },
          inboxId,
          onFinish: async (status) => {
            // 回合结束前没被领走的 next-step 消息不能留在“下一步”上：把它们
            // 变成下一回合的排队消息，否则它们永远不会被发送。
            try {
              await inbox.promoteStale(sessionId);
            } catch (error) {
              logger.warn(
                "[session] failed to promote pending steering messages",
                error
              );
            }
            STREAM_REGISTRY.unregisterStream(activeStreamId);
            await store.clearActiveStream(sessionId, activeStreamId, status);
          },
        });
      } catch (error) {
        if (error instanceof InboxMessageNotFoundError) {
          throw new ApiError("INBOX_MESSAGE_NOT_FOUND", {
            data: { sessionId, messageId: error.id },
          });
        }
        throw error;
      }

      STREAM_REGISTRY.registerStream(activeStreamId, agent, stream);
      await store.setActiveStream(sessionId, activeStreamId);

      return {
        activeStreamId,
        awaitingToolApprovals: 0,
      };
    });
  });

/**
 * Reads the turn a session is running.
 *
 * Located by session rather than by stream id: the id a client holds is the
 * session's, and the stream id names one particular turn.
 *
 * A reader that attaches part-way through gets the turn from its start — the
 * entry replays what it has buffered — so a page that reloaded can pick the
 * turn up rather than join it mid-sentence. Several readers may do this at
 * once; each gets its own stream.
 */
export const streamSession = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/stream" })
  .errors({ STREAM_NOT_FOUND: ErrorMap.STREAM_NOT_FOUND })
  .input(z.object({ sessionId: z.string() }))
  .handler(({ input }) => {
    const streamEntry = STREAM_REGISTRY.getStreamEntryBySession(
      input.sessionId
    );
    if (!streamEntry) {
      throw new ApiError("STREAM_NOT_FOUND", {
        data: { sessionId: input.sessionId },
      });
    }

    return streamToEventIterator(streamEntry.readable());
  });

/**
 * Stops the turn a session is running.
 *
 * Nothing else can, now that a turn outlives its request: closing the window
 * that asked for it leaves it running on purpose. Absent a running turn this is
 * a no-op rather than an error — the caller asked for the turn to not be
 * running, and it is not.
 *
 * Answers only once the turn has ended, so a caller that stops and then reads
 * the session finds the aborted turn rather than racing its write.
 *
 * A session left marked as running with no turn behind it — one that ended with
 * the process, or that finished just before the lookup — has that marker
 * cleared, so a reloaded client is not left trying to resume a turn that is
 * gone. That is also why the marker is cleared here rather than left to the
 * turn's own finish: this one runs behind a hook and a store write, and the
 * stop should answer with the session already settled.
 *
 * Both paths settle the session to `canceled`: the turn the caller asked to
 * stop is one that did not run to completion, whether this call ended it or
 * found it already gone.
 *
 * 子会话的行也在这里收尾。父一停，子 agent 的 signal 跟着停（见
 * `createSubagent`），它自己会把行清掉——但那要等它跑完，而进程被杀时根本不会
 * 发生。所以停完再按库扫一遍父派生出的会话，把还挂着 `activeStreamId` 的行清掉，
 * 免得刷新后有一个永远"运行中"的子会话。
 */
export const stopSession = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/stop" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const { sessionId } = input;
    const store = new SQLiteStore();

    const streamEntry = STREAM_REGISTRY.getStreamEntryBySession(sessionId);
    if (!streamEntry || streamEntry.isDone()) {
      const session = await store.getSessionById(sessionId);
      if (session?.activeStreamId) {
        await store.clearActiveStream(
          sessionId,
          session.activeStreamId,
          "canceled"
        );
      }
      await clearChildSessions(store, sessionId);
      return { aborted: false };
    }

    streamEntry.agent.abort();
    await streamEntry.whenFinished();
    await store.clearActiveStream(sessionId, streamEntry.streamId, "canceled");
    await clearChildSessions(store, sessionId);

    return { aborted: true };
  });

/**
 * 把一个会话派生出的、还挂着流的子会话行清掉。
 *
 * 只动 `activeStreamId` 非空的行：已经跑完的子会话是 `done`，清它会把它从"没读
 * 过"抹成 `canceled`，而它并没有被取消。
 *
 * 和父会话那边一样用 compare-and-clear，所以重复调用是安全的——子 agent 自己
 * 先清过了，这里就查不到东西可清。
 */
async function clearChildSessions(
  store: SQLiteStore,
  parentSessionId: string
): Promise<void> {
  const children = await store.listChildSessions(parentSessionId);

  for (const child of children) {
    if (child.activeStreamId) {
      await store.clearActiveStream(child.id, child.activeStreamId, "canceled");
    }
  }
}

/**
 * Marks the finished turn a session is showing as read.
 *
 * A session that ran a turn to completion sits in `done` until someone looks at
 * it — that is the state the sidebar draws a check for. Opening the session is
 * the looking, so this is what retires the mark.
 *
 * Narrow by design: only `done` moves, so a `running` session is not disturbed
 * by a page that opened while its turn was still going, and a settled
 * `canceled`/`error` session stays settled. Answering `updated: 0` is the
 * ordinary outcome of marking a session that had nothing to mark.
 */
const markSessionRead = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/read" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    const updated = await store.markSessionRead(input.sessionId);
    return { sessionId: input.sessionId, updated };
  });

const listSessions = publicProcedure
  .route({ method: "GET", path: "/sessions" })
  .input(
    type<{
      cursor?: string;
      limit?: number;
      direction?: "asc" | "desc";
      /** 只列这个项目的会话；省略时跨项目列出。 */
      projectId?: string;
    }>()
  )
  .handler(async ({ input }) => {
    const { cursor, limit, direction, projectId } = input;
    const store = new SQLiteStore();
    const sessions = await store.listSessions({
      cursor,
      limit,
      direction,
      kind: "main",
      projectId,
    });
    return { sessions };
  });

const getSession = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const { sessionId } = input;
    const store = new SQLiteStore();
    const session = await store.getSessionById(sessionId);
    return { session };
  });

// PUT /sessions/{sessionId} — rename a session
const updateSession = publicProcedure
  .route({ method: "PUT", path: "/sessions/{sessionId}" })
  .input(
    z.object({
      sessionId: z.string(),
      title: z.string().trim().min(1).max(200),
    })
  )
  .handler(async ({ input }) => {
    const { sessionId, title } = input;
    const store = new SQLiteStore();

    const existing = await store.getSessionById(sessionId);
    if (!existing) {
      throw new ApiError("SESSION_NOT_FOUND", { data: { sessionId } });
    }

    const updated = await store.updateSessionById(sessionId, title);
    return { sessionId, title, updated };
  });

export const listSessionTurns = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/turns" })
  .input(listSessionTurnsSchema)
  .handler(async ({ input }) => {
    const { sessionId } = input;

    const store = new SQLiteStore();
    const session = await store.getSessionById(sessionId);

    if (!session) {
      return [];
    }

    const activeBranchTurns = await store.getBranchTurns(session.id, {
      activeStreamId: session.activeStreamId ?? undefined,
    });

    return activeBranchTurns.map((message) => message.content);
  });

export const forkSession = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/fork" })
  .errors({
    SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND,
    MESSAGE_NOT_FOUND: ErrorMap.MESSAGE_NOT_FOUND,
    NOTHING_TO_FORK: ErrorMap.NOTHING_TO_FORK,
  })
  .input(forkSessionSchema)
  .handler(async ({ input }) => {
    const { sessionId, messageId } = input;

    const store = new SQLiteStore();
    const source = await store.getSessionById(sessionId);
    if (!source) {
      throw new ApiError("SESSION_NOT_FOUND", { data: { sessionId } });
    }

    const branchTurns = await store.getBranchTurns(source.id, {
      activeStreamId: source.activeStreamId ?? undefined,
    });
    const upToIndex = messageId
      ? branchTurns.findIndex((turn) => turn.id === messageId)
      : branchTurns.length - 1;
    if (upToIndex < 0) {
      throw new ApiError("MESSAGE_NOT_FOUND", {
        data: { sessionId, messageId },
      });
    }

    const prefix = branchTurns.slice(0, upToIndex + 1);
    if (prefix.length === 0) {
      throw new ApiError("NOTHING_TO_FORK");
    }

    const newSessionId = generateSessionId();
    // Copy rows with fresh ids: message.id and step.id are global primary keys,
    // and the fork must be self-contained — later edits in either session must
    // not affect the other.
    const idMap = new Map<string, string>();
    const copies: TurnWrite[] = prefix.map((message) => {
      const newTurnId = generateTurnId();
      idMap.set(message.id, newTurnId);
      return {
        id: newTurnId,
        sessionId: newSessionId,
        type: message.type,
        metadata: message.metadata,
        content: cloneTurnContent(message.content, newTurnId, idMap),
        parentId: message.parentId
          ? (idMap.get(message.parentId) ?? null)
          : null,
        createdAt: message.createdAt,
      };
    });

    await store.saveSession({
      id: newSessionId,
      title: `Fork: ${source.title}`,
      metadata: {},
      activeHeadId: copies.at(-1)?.id ?? null,
      forkedFromSessionId: source.id,
      forkedFromMessageId: messageId ?? prefix.at(-1)?.id,
      // fork 出来的会话留在源会话的项目里，否则按项目列表时会凭空少一条。
      projectId: source.projectId,
    });
    await store.saveTurns(copies);

    return { sessionId: newSessionId };
  });

/**
 * 复制一条 turn，并给它的 step 换新的 id。
 *
 * turn id 和 step id 都是全局主键，fork 必须重新生成。压缩记录里的
 * `retainedFromTurnId` 也指向 turn id，必须映射到新会话里的对应 turn，否则
 * 投影在 fork 里找不到保留段，会把已有历史整段丢掉。
 */
function cloneTurnContent(
  turn: AgentTurn<AgentToolSet>,
  newTurnId: string,
  idMap: Map<string, string>
): AgentTurn<AgentToolSet> {
  const steps = turn.content.map((step): AgentStep<AgentToolSet> => {
    const id = generateStepId();

    if (step.type !== "compaction") {
      return { ...step, id };
    }

    const content = step.content.map((part) => {
      if (part.type !== "compaction" || !part.record?.retainedFromTurnId) {
        return part;
      }

      const { retainedFromTurnId: previous, ...record } = part.record;
      const retainedFromTurnId = idMap.get(previous);
      return {
        ...part,
        record: retainedFromTurnId ? { ...record, retainedFromTurnId } : record,
      };
    });

    return { ...step, id, content };
  });

  return { ...turn, id: newTurnId, content: steps } as AgentTurn<AgentToolSet>;
}

export const listSessionResources = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/resources" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    // 资源与建会话时用的项目保持一致；会话还没落库时退回到默认项目。
    const store = new SQLiteStore();
    const session = await store.getSessionById(input.sessionId);
    const projectDir = await getPrimaryProjectDir(
      session?.projectId ?? undefined
    );
    const skillManager = new SkillManager({ dirs: SKILL_DIRS });
    await skillManager.loadSkills(projectDir);

    // 与技能一样，上下文文件每次请求都从源重新读取，保证界面看到的是磁盘
    // 当前内容（AGENTS.md / CLAUDE.md 可能在会话期间被编辑）。
    const context = await loadContextFiles([new FileSystemContextSource()], {
      projectDir,
    });

    return { skills: skillManager.listUserAvailableSkills(), context };
  });

/**
 * 按需压缩一个空闲会话。
 *
 * 和普通回合一样，这里只负责准备工作并把压缩交给 stream：会话检查、agent
 * 装配、流注册，然后返回 streamId；摘要本身在后台跑。客户端从
 * `/sessions/{id}/stream` 读事件，压缩 turn 落库先于流关闭，所以读完再取
 * branch 一定能看到新标记。
 *
 * 选段仍然在流创建之前完成，`NOTHING_TO_COMPACT` 因此还是同步错误——调用方
 * 不需要先拿 streamId 再等一条失败事件才知道没有可压缩的内容。
 */
export const compactSession = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/compact" })
  .errors({
    MODEL_NOT_FOUND: ErrorMap.MODEL_NOT_FOUND,
    SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND,
    SESSION_BUSY: ErrorMap.SESSION_BUSY,
    NOTHING_TO_COMPACT: ErrorMap.NOTHING_TO_COMPACT,
  })
  .input(z.object({ sessionId: z.string(), model: z.string() }))
  .handler(async ({ input }) => {
    const { sessionId, model } = input;
    const aiModel = await findAiModelById(model);
    if (!aiModel) {
      throw new ApiError("MODEL_NOT_FOUND", { data: { model } });
    }

    return await withSessionLock(sessionId, async () => {
      const store = new SQLiteStore();
      const inbox = new AgentInbox(store);
      const session = await store.getSessionById(sessionId);
      if (!session) {
        throw new ApiError("SESSION_NOT_FOUND", { data: { sessionId } });
      }

      const running = STREAM_REGISTRY.getStreamEntryBySession(sessionId);
      if ((running && !running.isDone()) || session.activeStreamId) {
        throw new ApiError("SESSION_BUSY", {
          data: { sessionId, reason: "running" },
        });
      }

      const branch = await store.getBranchTurns(sessionId);
      const turns = AgentSession.toAgentTurns(branch);
      if (
        findTurnWithoutToolResult(turns) !== null ||
        findToolApprovalRequests(turns).length > 0
      ) {
        throw new ApiError("SESSION_BUSY", {
          data: { sessionId, reason: "wait_review" },
        });
      }

      const agent = await buildSessionAgent({
        sessionId,
        aiModel,
        projectId: session.projectId ?? undefined,
        session: new AgentSession({ turns }),
        store,
      });

      const activeStreamId = generateSessionId();
      // 先落 activeStreamId 再启动流：压缩可能在流注册之前就结束，那时
      // onFinish 的 compare-and-clear 必须能找到自己这一行。
      const previousStatus =
        session.status === "running" ? "error" : session.status;
      await store.setActiveStream(sessionId, activeStreamId);

      let stream;
      try {
        stream = await agent.stream({
          turns,
          modelId: aiModel.model,
          streamId: activeStreamId,
          signal: { type: "compaction", trigger: "manual" },
          onFinish: async () => {
            try {
              await inbox.promoteStale(sessionId);
            } catch (error) {
              logger.warn(
                "[session] failed to promote pending steering messages",
                error
              );
            }
            STREAM_REGISTRY.unregisterStream(activeStreamId);
            // 压缩只插入一条上下文标记 turn，不是模型回复：成功或失败都不该
            // 改写会话原来的状态——一条完好的会话不该因为摘要失败被标成
            // error，也不该平白多出一个未读的 done。
            await store.clearActiveStream(
              sessionId,
              activeStreamId,
              previousStatus
            );
          },
        });
      } catch (error) {
        await store.clearActiveStream(
          sessionId,
          activeStreamId,
          previousStatus
        );
        if (error instanceof NothingToCompactError) {
          throw new ApiError("NOTHING_TO_COMPACT");
        }
        throw error;
      }

      STREAM_REGISTRY.registerStream(activeStreamId, agent, stream);

      return { activeStreamId };
    });
  });

/**
 * 列出会话的待发送消息。
 *
 * 已领取的行会被删除，所以这里只返回仍然排队的消息；客户端刷新后据此恢复
 * 队列 dock。
 */
export const listInboxMessages = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/inbox" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { messages: await inbox.list(input.sessionId) };
  });

/**
 * 入队一条消息。
 *
 * placement 由当前流决定：运行中的普通回合 + steering 才是下一步；空闲、
 * 等待审批、手工压缩都排到下一回合。同 (sessionId, requestId) 的重试返回
 * 已有行，不会重复入队。
 */
export const enqueueInboxMessage = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/inbox" })
  .errors({ SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND })
  .input(
    type<{
      sessionId: string;
      requestId: string;
      mode: InboxMode;
      turn: AgentUserTurn;
      model: string;
      modelEffort?: string;
      projectId?: string;
    }>()
  )
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    const session = await store.getSessionById(input.sessionId);
    if (!session) {
      throw new ApiError("SESSION_NOT_FOUND", {
        data: { sessionId: input.sessionId },
      });
    }

    const running = STREAM_REGISTRY.getStreamEntryBySession(input.sessionId);
    const placement = resolveInboxPlacement({
      mode: input.mode,
      running: running !== undefined && !running.isDone(),
      streamKind: running?.agent.streamKind,
    });

    const inbox = new AgentInbox(store);
    const message = await inbox.enqueue({
      sessionId: input.sessionId,
      requestId: input.requestId,
      placement,
      content: input.turn,
      payload: {
        model: input.model,
        modelEffort: input.modelEffort,
        projectId: session.projectId ?? input.projectId ?? undefined,
      },
    });

    return { message };
  });

/** 移除一条待发送消息。 */
export const cancelInboxMessage = publicProcedure
  .route({
    method: "DELETE",
    path: "/sessions/{sessionId}/inbox/{messageId}",
  })
  .input(inboxMessageIdSchema)
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { removed: await inbox.cancel(input.sessionId, input.messageId) };
  });

/** 清空会话的待发送消息。 */
export const clearInboxMessages = publicProcedure
  .route({ method: "DELETE", path: "/sessions/{sessionId}/inbox" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const inbox = new AgentInbox(new SQLiteStore());
    return { removed: await inbox.clear(input.sessionId) };
  });

export const session = {
  create: createSession,
  list: listSessions,
  get: getSession,
  update: updateSession,
  markRead: markSessionRead,
  listSessionTurns,
  listSessionResources,
  compact: compactSession,
  fork: forkSession,
  stream: streamSession,
  stop: stopSession,
  listInbox: listInboxMessages,
  enqueueInbox: enqueueInboxMessage,
  cancelInbox: cancelInboxMessage,
  clearInbox: clearInboxMessages,
};
