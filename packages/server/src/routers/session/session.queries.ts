import { type } from "@orpc/server";
import { loadContextFiles } from "@workspace/agent";
import { DEFAULT_BOT_ID } from "@workspace/agent-client";
import { SkillManager, SKILL_DIRS } from "@workspace/agent/skill";
import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import {
  buildBotSkillLoadOptions,
  createBotContextSource,
  resolveSessionDirectories,
} from "../../session/directories";
import { encodeSessionCursor } from "../../storage/session-cursor";
import {
  DEFAULT_SESSION_PAGE_SIZE,
  SQLiteStore,
} from "../../storage/sqlite-store";
import { approvalPolicySchema, listSessionTurnsSchema } from "./session.schema";

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
      /** Filter to one Project when provided. */
      projectId?: string;
      /** Filter to one Bot when provided. */
      botId?: string;
    }>()
  )
  .handler(async ({ input }) => {
    const { cursor, limit, direction, projectId, botId } = input;
    const pageSize = limit ?? DEFAULT_SESSION_PAGE_SIZE;
    const store = new SQLiteStore();
    const sessions = await store.listSessions({
      cursor,
      limit: pageSize,
      direction,
      kind: "main",
      projectId,
      botId,
    });
    // 游标由服务端给出，不由客户端从最后一行反推：排序键是 (updatedAt, id)，
    // 客户端只拿到行、拼不出这个键。不足一页说明到底了，就不发游标。
    const last = sessions.at(-1);
    const nextCursor =
      sessions.length < pageSize || last === undefined
        ? undefined
        : encodeSessionCursor(last);
    return { sessions, nextCursor };
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
  .input(
    z.object({
      sessionId: z.string(),
      botId: z.string().min(1).optional(),
      projectId: z.string().min(1).optional(),
    })
  )
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    const session = await store.getSessionById(input.sessionId);
    const botId = session?.botId ?? input.botId ?? DEFAULT_BOT_ID;
    const projectId = session
      ? (session.projectId ?? undefined)
      : input.projectId;
    const dirs = await resolveSessionDirectories({ botId, projectId });

    const skillManager = new SkillManager({ dirs: SKILL_DIRS });
    await skillManager.loadSkills(buildBotSkillLoadOptions(dirs));

    const context = await loadContextFiles([createBotContextSource(dirs)], {
      projectDir: dirs.primaryDir,
    });

    return { skills: skillManager.listUserAvailableSkills(), context };
  });

/**
 * Change the Approval Policy of a session.
 *
 * It changes this column only and does not touch the Run state: a policy change does not stop
 * the running Turn; the next Run assembles with the new value. A deleted session counts as absent.
 */
export const setApprovalPolicy = publicProcedure
  .route({ method: "PUT", path: "/sessions/{sessionId}/approval-policy" })
  .input(
    z.object({
      sessionId: z.string(),
      approvalPolicy: approvalPolicySchema,
    })
  )
  .errors({ SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND })
  .handler(async ({ input }) => {
    const { sessionId, approvalPolicy } = input;
    const store = new SQLiteStore();

    const existing = await store.getSessionById(sessionId);
    if (!existing) {
      throw new ApiError("SESSION_NOT_FOUND", { data: { sessionId } });
    }

    await store.setSessionApprovalPolicy(sessionId, approvalPolicy);

    return { sessionId, approvalPolicy };
  });
