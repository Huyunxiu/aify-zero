import { structuredLogger } from "@hono/structured-logger";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { resolveApiToken } from "@workspace/shared/api-token";
import type { AuthEnv } from "@workspace/shared/auth-session";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_HEADER,
  SUPPORTED_LANGUAGES,
} from "@workspace/shared/constants";
import { getErrorCause } from "@workspace/shared/errors";
import type { Logger } from "@workspace/shared/logger";
import { logger } from "@workspace/shared/logger";
import { Hono } from "hono";
import { languageDetector } from "hono/language";
import { requestId } from "hono/request-id";

import { authenticate } from "./auth";
import {
  registerPrivateAuthRoutes,
  registerPublicAuthRoutes,
} from "./auth-routes";
import type { AuthRouteOptions } from "./auth-routes";
import type { AuthStore } from "./auth-store";
import { createAuthStore } from "./auth-store";
import { createContext } from "./context";
import type { HonoEnv } from "./hono-env";
import {
  handleMcpAuthorizationCallback,
  renderMcpAuthorizationPage,
} from "./mcp/oauth-callback";
import { appRouter } from "./routers/index";
import { serveWorkspaceFile } from "./routers/workspace/workspace.file-route";
import { resolveSessionWorkspace } from "./routers/workspace/workspace.service";
import { mountWebApp, resolveWebRoot } from "./web-dist";

export const apiHandler = new OpenAPIHandler(appRouter, {
  interceptors: [
    onError((error, options) => {
      options.context.logger.error(
        "orpc api handler error",
        getErrorCause(error) ?? error
      );
    }),
  ],
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
  ],
});

export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error, options) => {
      options.context.logger.error(
        "orpc rpc handler error",
        getErrorCause(error) ?? error
      );
    }),
  ],
});

/** `createApp` 的选项。 */
export interface CreateAppOptions {
  /**
   * 非浏览器客户端必须出示的访问令牌。默认取 `AIFY_API_TOKEN` /
   * `~/.aify-zero/api-token`；测试传固定值，免得读写用户的 home 目录。
   */
  readonly apiToken?: () => string;
  /**
   * 浏览器登录态的存储。默认用全局数据库连接；测试注入指向临时库的实例。
   */
  readonly authStore?: AuthStore;
  /** 来源白名单：允许携带登录态的浏览器源。 */
  readonly trustedOrigins?: ReadonlySet<string>;
  /**
   * 前端产物目录。不传时按仓库布局推断；传 `null` 关闭静态托管，测试用。
   */
  readonly webRoot?: string | null;
  /** 环境变量表；测试注入。 */
  readonly env?: AuthEnv;
}

/**
 * 构造 API 应用。
 *
 * 工厂而不是模块级单例，测试才能注入已知令牌；生产实例由 `serve.ts` 建。
 */
export const createApp = ({
  apiToken = resolveApiToken,
  authStore,
  trustedOrigins,
  webRoot,
  env = process.env,
}: CreateAppOptions = {}): Hono<HonoEnv> => {
  const app = new Hono<HonoEnv>();
  // 登录路由和鉴权中间件必须拿到同一个存储实例；没有注入时在这里建一次，
  // 免得某个入口漏传、运行时才在 /login 上返回 500。
  const resolvedStore = authStore ?? createAuthStore();
  const authOptions: AuthRouteOptions = {
    apiToken,
    authStore: resolvedStore,
    env,
    trustedOrigins,
  };
  const requireAuth = authenticate(authOptions);

  app.use(requestId());
  app.use(
    // The UI's language rides along on every oRPC call (see the oRPC links), and
    // that header is the only thing consulted: a client that says nothing gets
    // the default rather than whatever locale its browser happens to run in.
    // Nothing is cached server-side — the user's choice lives in the UI, so
    // re-reading it per request is what keeps the two in step.
    languageDetector({
      supportedLanguages: SUPPORTED_LANGUAGES,
      fallbackLanguage: DEFAULT_LANGUAGE,
      lookupFromHeaderKey: LANGUAGE_HEADER,
      order: ["header"],
      caches: false,
    })
  );
  app.use(
    structuredLogger<HonoEnv, Logger, string>({
      createLogger: (c) => logger.createLogger({ scope: c.var.requestId }),
      contextKey: "logger",
      onResponse: (_logger, c, elapsedMs) => {
        _logger.info(
          `${c.req.method} ${c.req.path} ${c.res.status} ${elapsedMs.toFixed(0)}ms`
        );
      },
      onError: (_logger, err, c, elapsedMs) =>
        _logger.error(
          `${c.req.method} ${c.req.path} ${c.res.status} ${elapsedMs.toFixed(0)}ms`,
          err
        ),
    })
  );

  // 公开入口：登录页、登录态查询、MCP 授权回调。它们都在鉴权之前，
  // 各自的安全边界写在各自的注释里。
  registerPublicAuthRoutes(app, authOptions);

  // MCP 授权的回环回调：浏览器带 `code` 回来时没有 bearer token，所以这条
  // 路由必须在鉴权之前。它只按 `state` 找回流程，不放宽任何别的路由。
  // 见 docs/adr/0003。
  app.get("/api/mcp/oauth/callback", async (c) => {
    const result = await handleMcpAuthorizationCallback({
      code: c.req.query("code"),
      state: c.req.query("state"),
      issuer: c.req.query("iss"),
    });

    return c.html(renderMcpAuthorizationPage(result), result.ok ? 200 : 400);
  });

  // 鉴权排在日志之后：被拒的请求也要进访问日志。排在 oRPC 之前：没有任何
  // 路由能绕过它。只覆盖 `/api/*`：文档和静态资源必须在浏览器拿到登录态之前
  // 就能加载，否则连登录页都打不开。
  app.use("/api/*", requireAuth);

  // 工作区文件的字节通道：`<img src>` 和下载都要一条普通 GET，而 RPC 只走
  // JSON。放在 oRPC 兜底之前，这类请求不必先经过一次 handler 匹配。
  app.get("/api/workspace/file", (c) =>
    serveWorkspaceFile(c.req.raw, { resolveRoots: resolveSessionWorkspace })
  );

  registerPrivateAuthRoutes(app, authOptions);

  // 没有 CORS 中间件：页面永远和 API 同源（server 托管产物，开发期由 Vite
  // 代理），跨源读取本来就不该被允许。登录态是 cookie，浏览器会自动带上，
  // 所以 `authenticate` 对 cookie 请求检查 `Origin` 和 `Sec-Fetch-Site`。
  app.use("/*", async (c, next) => {
    const context = await createContext({
      requestId: c.var.requestId,
      logger: c.var.logger,
      language: c.var.language,
      signal: c.req.raw.signal,
    });

    const rpcResult = await rpcHandler.handle(c.req.raw, {
      context,
      prefix: "/api/rpc",
    });

    if (rpcResult.matched) {
      return c.newResponse(rpcResult.response.body, rpcResult.response);
    }

    const apiResult = await apiHandler.handle(c.req.raw, {
      context,
      prefix: "/api/openapi",
    });

    if (apiResult.matched) {
      return c.newResponse(apiResult.response.body, apiResult.response);
    }

    await next();
  });

  /**
   * 就绪探针：桌面壳在 attach 前用它确认 origin 上确实跑着一个 Aify Zero
   * API，而不是别的进程占用了端口。探针和其他路由一样需要凭据，否则占端口
   * 的进程可以骗桌面端 attach 并拿到转发时注入的令牌。
   */
  app.get("/health", requireAuth, (c) =>
    c.json({ ok: true, pid: process.pid, uptime: process.uptime() })
  );

  const resolvedWebRoot =
    webRoot === null ? undefined : (webRoot ?? resolveWebRoot(env));

  if (resolvedWebRoot !== undefined) {
    mountWebApp(app, resolvedWebRoot);
  }

  app.get("/", (c) => c.text("OK"));

  app.notFound((c) => c.text("Not Found", 404));

  return app;
};
