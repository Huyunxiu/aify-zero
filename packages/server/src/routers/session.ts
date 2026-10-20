import { homedir } from "node:os";

import { streamToEventIterator, type } from "@orpc/server";
import {
  createBashTool,
  createReadFileTool,
  createWriteFileTool,
  createDeleteFileTool,
  createEditFileTool,
  createGrepTool,
  createGlobTool,
  createWebFetchTool,
  createTaskTool,
  Agent,
  appendSubagentPrompt,
  FileSystemContextSource,
  FileSystemSkillSource,
  loadContextFiles,
  loadSkills,
  renderProjectContext,
  STREAM_REGISTRY,
  SUBAGENT_DEFINITIONS,
} from "@workspace/agent";
import type { AgentToolSet } from "@workspace/agent";
import {
  addToolApprovalResponse,
  findToolApprovalRequests,
} from "@workspace/agent-client";
import type {
  AgentTurn,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import { AgentContext } from "@workspace/agent/agent-context";
import { AgentSession } from "@workspace/agent/agent-session";
import { SKILL_DIRS, SkillManager } from "@workspace/agent/skill/index";
import { SQLiteStore } from "@workspace/agent/storage/sqlite-store";
import { createLoadSkillTool } from "@workspace/agent/tools/load-skill";
import {
  generateSessionId,
  generateTurnId,
} from "@workspace/agent/utils/id-util";
import type { TurnInsertModel } from "@workspace/db";
import { ModelEffort } from "@workspace/shared/constants";
import z from "zod";

import { ApiError, ErrorMap } from "../errors";
import { publicProcedure } from "../index";
import { forkSessionSchema, listSessionTurnsSchema } from "./session.schema";
import { findAiModelById } from "./settings/settings.service";

const createSession = publicProcedure
  .route({ method: "POST", path: "/sessions" })
  .errors({ MODEL_NOT_FOUND: ErrorMap.MODEL_NOT_FOUND })
  .input(
    type<{
      sessionId: string;
      turns: AgentTurn<AgentToolSet>[];
      approvals?: TextStreamToolApprovalResponseEvent[];
      model: string;
      modelEffort?: string;
    }>()
  )
  .handler(async ({ input }) => {
    const { sessionId, turns, approvals, model, modelEffort } = input;

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

    const store = new SQLiteStore();
    const previousMessages = await store.getBranchTurns(sessionId);
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

    // const workdir = homedir();
    const workdir = "/Users/huyunxiu/HuYunXiu/aify-zero";
    // 资源从 source 加载：现在只有文件系统，以后加数据库源只需要往数组里
    // 追加一项，排序和去重仍由这一层统一处理。
    const loadContext = { workdir };
    const skillManager = SkillManager.fromSkills(
      await loadSkills(
        [new FileSystemSkillSource({ dirs: SKILL_DIRS })],
        loadContext
      ),
      { dirs: SKILL_DIRS }
    );

    const contextFiles = await loadContextFiles(
      [new FileSystemContextSource()],
      loadContext
    );

    const agentContext = new AgentContext({
      workdir,
      modelId: aiModel.model,
      modelEffort: effort,
      skills: skillManager,
      contextFiles,
      compactionConfig: {
        recentWindowSize: 10,
        threshold: 100_000,
        thresholdPercent: 0.9,
        lastKnownInputTokens: 0,
        lastKnownPromptMessageCount: 0,
      },
    });

    const systemPrompt = appendSubagentPrompt(
      skillManager.appendPrompt(renderProjectContext(contextFiles))
    );

    const agent = new Agent({
      name: "main",
      sessionId,
      systemPrompt,
      modelEffort: effort,
      context: agentContext,
      session,
      tools: {
        bash: createBashTool({ agentContext }),
        "read-file": createReadFileTool({ agentContext }),
        "write-file": createWriteFileTool({ agentContext }),
        "delete-file": createDeleteFileTool({ agentContext }),
        "edit-file": createEditFileTool({ agentContext }),
        grep: createGrepTool({ agentContext }),
        glob: createGlobTool({ agentContext }),
        "web-fetch": createWebFetchTool({ agentContext }),
        "load-skill": createLoadSkillTool({ agentContext }),
      },
      store,
      apiKey: aiModel.apiKey,
      apiUrl: aiModel.apiUrl,
      providerId: aiModel.provider,
      modelId: aiModel.model,
    });

    agent.registerTool(
      "task",
      createTaskTool({
        agent,
        agentContext,
        definitions: SUBAGENT_DEFINITIONS,
      })
    );

    const activeStreamId = generateSessionId();

    const stream = await agent.stream({
      turns: originalTurns,
      modelId: aiModel.model,
      onFinish: async (status) => {
        STREAM_REGISTRY.unregisterStream(activeStreamId);
        await store.clearActiveStream(sessionId, activeStreamId, status);
      },
    });

    STREAM_REGISTRY.registerStream(activeStreamId, agent, stream);
    await store.setActiveStream(sessionId, activeStreamId);

    return {
      activeStreamId,
      awaitingToolApprovals: 0,
    };
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
    type<{ cursor?: string; limit?: number; direction?: "asc" | "desc" }>()
  )
  .handler(async ({ input }) => {
    const { cursor, limit, direction } = input;
    const store = new SQLiteStore();
    const sessions = await store.listSessions({
      cursor,
      limit,
      direction,
      kind: "main",
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

    const turns = await store.getAllTurnsBySessionId(session.id);
    const activeBranchTurns = await store.getBranchTurns(session.id, turns);

    return activeBranchTurns.map(
      (message) => message.content as AgentTurn<AgentToolSet>
    );
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

    const turns = await store.getAllTurnsBySessionId(sessionId);
    const branchTurns = await store.getBranchTurns(source.id, turns);
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
    // Copy rows with fresh ids: message.id is a global primary key, and the
    // fork must be self-contained — later edits in either session must not
    // affect the other.
    const idMap = new Map<string, string>();
    const copies: TurnInsertModel[] = prefix.map((message) => {
      const newTurnId = generateTurnId();
      idMap.set(message.id, newTurnId);
      return {
        id: newTurnId,
        sessionId: newSessionId,
        type: message.type,
        metadata: message.metadata,
        content: message.content,
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
    });
    await store.saveTurns(copies);

    return { sessionId: newSessionId };
  });

export const listSessionResources = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/resources" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async () => {
    const workdir = homedir();
    const skillManager = new SkillManager({ dirs: SKILL_DIRS });
    await skillManager.loadSkills(workdir);

    return { skills: skillManager.listUserAvailableSkills() };
  });

export const session = {
  create: createSession,
  list: listSessions,
  get: getSession,
  markRead: markSessionRead,
  listSessionTurns,
  listSessionResources,
  fork: forkSession,
  stream: streamSession,
  stop: stopSession,
};
