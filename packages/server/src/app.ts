import type { StructuredLoggerEnv } from "@hono/structured-logger";
import { structuredLogger } from "@hono/structured-logger";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { Logger } from "@workspace/shared/logger";
import { logger } from "@workspace/shared/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";

import { createContext } from "./context";
import { appRouter } from "./routers/index";

type HonoEnv = StructuredLoggerEnv<Logger, "logger">;

export const app = new Hono<HonoEnv>();

app.use(requestId());
app.use(
  structuredLogger<HonoEnv, Logger, string>({
    createLogger: (c) => logger.createLogger({ scope: c.var.requestId }),
    contextKey: "logger",
    onResponse: async (_logger, c, elapsedMs) => {
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
    onError((error) => {
      console.error(error);
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
    onError((error) => {
      console.error(error);
    }),
  ],
});

app.use("/*", async (c, next) => {
  const context = await createContext({
    requestId: c.var.requestId,
    logger: c.var.logger,
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
