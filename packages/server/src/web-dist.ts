/**
 * 把前端产物挂在 `<server>/` 下。
 *
 * 远程访问时页面必须和 API 同源：cookie 的 `SameSite`、预检和来源白名单都靠
 * 这一点才不用再补一套 CORS。开发期页面由 Vite 提供，这里不挂。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { WEB_ROOT_ENV } from "@workspace/shared/auth-session";
import type { AuthEnv } from "@workspace/shared/auth-session";
import type { Hono } from "hono";

import type { HonoEnv } from "./hono-env";

/** 仓库里 `apps/web/dist` 的位置；从源码和从 `apps/server/dist` 都是三层。 */
const DEFAULT_WEB_ROOT = path.resolve(
  import.meta.dirname,
  "../../../apps/web/dist"
);

const isApiPath = (pathname: string): boolean =>
  pathname === "/api" || pathname.startsWith("/api/");

/**
 * 解析前端产物目录。
 *
 * 显式配置了就要求它可用：配错了应当在启动时报错，而不是悄悄返回一个
 * 404 页面。没配置时按仓库布局推断，推断不到就是“不托管”。
 *
 * @param env - 环境变量。
 * @returns 可用的目录，或 undefined。
 */
export function resolveWebRoot(env: AuthEnv = process.env): string | undefined {
  const configured = env[WEB_ROOT_ENV]?.trim();

  if (configured !== undefined && configured !== "") {
    if (!existsSync(path.join(configured, "index.html"))) {
      throw new Error(`${WEB_ROOT_ENV} does not contain index.html`);
    }

    return configured;
  }

  return existsSync(path.join(DEFAULT_WEB_ROOT, "index.html"))
    ? DEFAULT_WEB_ROOT
    : undefined;
}

/**
 * 挂静态文件和 SPA 兜底。
 *
 * API 路径一律放行给后面的处理器：`/api/unknown` 应该是 404，而不是一份
 * HTML——客户端拿到 HTML 会报“JSON 解析失败”，比 404 难查得多。
 *
 * @param app - 目标应用。
 * @param root - 前端产物目录。
 */
export function mountWebApp(app: Hono<HonoEnv>, root: string): void {
  const serveFile = serveStatic({ root });
  const serveIndex = serveStatic({ path: "/index.html", root });

  app.use("/*", async (c, next) => {
    if (isApiPath(c.req.path)) {
      await next();

      return;
    }

    await serveFile(c, next);
  });

  app.get("/*", async (c, next) => {
    if (isApiPath(c.req.path)) {
      await next();

      return;
    }

    await serveIndex(c, next);
  });
}
