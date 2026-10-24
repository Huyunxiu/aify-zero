import type { StructuredLoggerEnv } from "@hono/structured-logger";
import { structuredLogger } from "@hono/structured-logger";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { resolveApiToken } from "@workspace/shared/api-token";
import type { Language } from "@workspace/shared/constants";
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

import { bearerAuth } from "./auth";
import { createContext } from "./context";
import { appRouter } from "./routers/index";

/**
 * `language` is narrowed from the `string` Hono's own `ContextVariableMap`
 * declares: the detector below is configured with `SUPPORTED_LANGUAGES` and
 * only ever sets one of them, so the wider type would be a lie here. The two
 * have to be changed together.
 */
type HonoEnv = StructuredLoggerEnv<Logger> & {
  Variables: { language: Language };
};

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

/**
 * Options for {@link createApp}.
 */
export interface CreateAppOptions {
  /**
   * Resolves the bearer token every request must present. Defaults to the
   * shared token in `AIFY_API_TOKEN` / `~/.aify-zero/api-token`; tests pass a
   * fixed value so they never touch the user's home directory.
   */
  readonly apiToken?: () => string;
}

/**
 * Build the API application.
 *
 * A factory rather than a module-level singleton so tests can inject a known
 * token; production keeps the single {@link app} export below.
 */
export const createApp = ({
  apiToken = resolveApiToken,
}: CreateAppOptions = {}): Hono<HonoEnv> => {
  const app = new Hono<HonoEnv>();

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
  // Auth sits after the logger, so rejected requests still reach the access log,
  // and before the oRPC handler, so no route can accidentally opt out.
  app.use(bearerAuth(apiToken));

  // 没有 CORS 中间件：浏览器永远经同源代理（Vite 或 aify-app:// 转发）访问
  // 这个进程，跨源读取本来就不该被允许。桌面转发和 Vite 代理都在服务端发起
  // 请求，因此也不需要预检响应。Bearer token 的自定义头还会让浏览器请求
  // 触发预检，进一步挡住跨站调用。

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

    return c.newResponse("Not Found", { status: 404 });
  });

  app.get("/", (c) => c.text("OK"));

  /**
   * 就绪探针：桌面壳在 attach 前用它确认 origin 上确实跑着一个 Aify Zero
   * API，而不是别的进程占用了端口。探针和其他路由一样需要 bearer token，
   * 否则占端口的进程可以骗桌面端 attach 并拿到转发时注入的令牌。
   */
  app.get("/health", (c) =>
    c.json({ ok: true, pid: process.pid, uptime: process.uptime() })
  );

  return app;
};

export const app = createApp();
