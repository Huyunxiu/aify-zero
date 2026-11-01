import { type } from "@orpc/server";
import { FileSystemContextSource, loadContextFiles } from "@workspace/agent";
import { SkillManager, SKILL_DIRS } from "@workspace/agent/skill/index";
import z from "zod";

import { ApiError } from "../../errors";
import { publicProcedure } from "../../index";
import { SQLiteStore } from "../../storage/sqlite-store";
import { getPrimaryProjectDir } from "../project/project.service";
import { listSessionTurnsSchema } from "./session.schema";

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
export const markSessionRead = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/read" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    const updated = await store.markSessionRead(input.sessionId);
    return { sessionId: input.sessionId, updated };
  });

export const listSessions = publicProcedure
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

export const getSession = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const { sessionId } = input;
    const store = new SQLiteStore();
    const session = await store.getSessionById(sessionId);
    return { session };
  });

// PUT /sessions/{sessionId} — rename a session
export const updateSession = publicProcedure
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
