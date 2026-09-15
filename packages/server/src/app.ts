import type { StructuredLoggerEnv } from "@hono/structured-logger";
import { structuredLogger } from "@hono/structured-logger";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
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
import { cors } from "hono/cors";
import { languageDetector } from "hono/language";
import { requestId } from "hono/request-id";

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

export const app = new Hono<HonoEnv>();

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

app.use(
  "/*",
  cors({
    allowMethods: ["GET", "POST", "OPTIONS", "PUT", "PATCH", "DELETE"],
    origin: "*",
  })
);

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

app.use("/*", async (c, next) => {
  const context = await createContext({
    requestId: c.var.requestId,
    logger: c.var.logger,
    language: c.var.language,
  });

  const rpcResult = await rpcHandler.handle(c.req.raw, {
    context,
    prefix: "/rpc",
  });

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response);
  }

  const apiResult = await apiHandler.handle(c.req.raw, {
    context,
    prefix: "/api-reference",
  });

  if (apiResult.matched) {
    return c.newResponse(apiResult.response.body, apiResult.response);
  }

  await next();

  return c.newResponse("Not Found", { status: 404 });
});

app.get("/", (c) => c.text("OK"));
