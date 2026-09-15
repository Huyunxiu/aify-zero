import { eventIteratorToUnproxiedDataStream, os } from "@orpc/server";

import type { Context } from "./context";
import { ApiError } from "./errors";

export const o = os.$context<Context>();

/**
 * Translates an `ApiError` into the `ORPCError` the client receives. Anything
 * else is rethrown untouched for `normalizeErrorMiddleware` to deal with, so a
 * handler can raise a business error by throwing `ApiError` and forget about
 * the transport.
 */
export const apiErrorMiddleware = o.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error.toORPCError();
    }
    throw error;
  }
});

/**
 * Outermost first: `apiErrorMiddleware` sits next to the handler and converts
 * what it recognizes, `normalizeErrorMiddleware` wraps everything as the
 * transport boundary.
 */
export const publicProcedure = o.use(apiErrorMiddleware);

export const stream = eventIteratorToUnproxiedDataStream;
