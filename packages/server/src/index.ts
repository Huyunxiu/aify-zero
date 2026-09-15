import { eventIteratorToUnproxiedDataStream, os } from "@orpc/server";

import type { Context } from "./context";
import { ApiError } from "./errors";

export const o = os.$context<Context>();

/**
 * Translates an `ApiError` into the `ORPCError` the client receives, in the
 * language this request asked for — the context is the only place that knows
 * it, and this middleware is where an error crosses from our own code into the
 * transport. Anything else is rethrown untouched, so a handler can raise a
 * business error by throwing `ApiError` and forget about the transport; the
 * ones it does not recognize are oRPC's to mask.
 */
export const apiErrorMiddleware = o.middleware(async ({ context, next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error.toORPCError(context.language);
    }
    throw error;
  }
});

/**
 * What every procedure is built from: `apiErrorMiddleware` sits next to the
 * handler and converts the errors we raise ourselves, the transport takes care
 * of the rest.
 */
export const publicProcedure = o.use(apiErrorMiddleware);

export const stream = eventIteratorToUnproxiedDataStream;
