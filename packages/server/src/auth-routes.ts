/**
 * 登录相关路由。
 *
 * 两组：
 *
 * - 公开：`POST /api/auth/login` 用票据换 cookie，`GET
 *   /api/auth/session` 只回答“有没有登录态”，页面据此决定显示应用还是提示页。
 * - 受保护：生成一条给别的设备用的登录链接、退出登录。
 *
 * 换 cookie 的入口和 MCP 授权的回调一样挂在鉴权之前：它本身就是取得凭据的
 * 入口。它的安全边界是票据——256 位随机、只随进程重启失效——不是访问令牌。
 */
import {
  isTrustedSessionRequest,
  resolvePublicOrigin,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@workspace/shared/auth-session";
import type { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

import { refreshSessionCookie, resolveAuth, sessionOrigins } from "./auth";
import type { AuthOptions } from "./auth";
import type { AuthStore } from "./auth-store";
import type { HonoEnv } from "./hono-env";
import { issueLoginLink, resolveLoginWebOrigin } from "./login-link";

/** 登录路由的依赖：存储是必需的，其余和鉴权中间件同一套。 */
export type AuthRouteOptions = AuthOptions & {
  readonly authStore: AuthStore;
};

/**
 * 从请求体里取出票据。
 *
 * 只接受 JSON 对象：表单能跨站提交，JSON 不能，等于又加了一道门槛。
 *
 * @param body - `c.req.json()` 的结果。
 */
const readTicket = (body: unknown): string | undefined => {
  if (
    typeof body !== "object" ||
    body === null ||
    !("ticket" in body) ||
    typeof body.ticket !== "string"
  ) {
    return undefined;
  }

  const ticket = body.ticket.trim();

  return ticket === "" ? undefined : ticket;
};

/**
 * 注册公开路由；必须在鉴权中间件之前调用。
 *
 * @param app - 目标应用。
 * @param options - 依赖。
 */
export const registerPublicAuthRoutes = (
  app: Hono<HonoEnv>,
  options: AuthRouteOptions
): void => {
  const env = options.env ?? process.env;

  app.post("/api/auth/login", async (c) => {
    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }

    const ticket = readTicket(body);

    if (ticket === undefined) {
      return c.json({ error: "missing_ticket" }, 400);
    }

    const userId = await options.authStore.findLoginTicket(ticket);

    if (userId === undefined) {
      return c.json({ error: "invalid_ticket" }, 401);
    }

    const session = await options.authStore.createSession(userId);

    setCookie(
      c,
      SESSION_COOKIE_NAME,
      session.token,
      sessionCookieOptions(env, c.req.url)
    );

    return c.body(null, 204);
  });

  app.get("/api/auth/session", async (c) => {
    const identity = await resolveAuth(c.req.raw.headers, options);

    if (identity?.kind === "session") {
      // 查询本身也带登录态，所以来源规则和别的路由一样；否则跨站页面能借它
      // 判断“这台机器上的人登录了没有”。
      if (
        !isTrustedSessionRequest(
          c.req.raw.headers,
          sessionOrigins(c.req.url, options)
        )
      ) {
        return c.json({ error: "forbidden" }, 403);
      }

      refreshSessionCookie(c, identity, options);
    }

    return c.json({ authenticated: identity !== undefined });
  });
};

/**
 * 注册受保护路由；必须在鉴权中间件之后调用。
 *
 * @param app - 目标应用。
 * @param options - 依赖。
 */
export const registerPrivateAuthRoutes = (
  app: Hono<HonoEnv>,
  options: AuthRouteOptions
): void => {
  const env = options.env ?? process.env;

  app.post("/api/auth/login-link", async (c) => {
    const identity = c.get("auth");
    // 登录态给谁签，就给谁签；访问令牌没有操作者，用唯一那一行。
    const userId =
      identity.kind === "session"
        ? identity.userId
        : await options.authStore.ensureOperator();
    const apiOrigin = resolvePublicOrigin(env) ?? new URL(c.req.url).origin;
    const link = await issueLoginLink({
      authStore: options.authStore,
      userId,
      webOrigin: await resolveLoginWebOrigin(apiOrigin, env),
    });

    return c.json({ url: link.url });
  });

  app.post("/api/auth/logout", async (c) => {
    const identity = c.get("auth");

    if (identity.kind === "session") {
      await options.authStore.deleteSession(identity.sessionToken);
    }

    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });

    return c.body(null, 204);
  });
};
