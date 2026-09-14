import { eventIteratorToUnproxiedDataStream, os } from "@orpc/server";

import type { Context } from "./context";
import { normalizeError } from "./errors";

export const stream3 = "3";

export const o = os.$context<Context>();

/**
 * Normalizes everything a procedure throws into an `ORPCError`, so the client
 * always receives a predictable code/status/message and server internals stay
 * behind the `cause`. Errors raised while a returned event iterator is being
 * consumed happen after this returns — those are handled by the agent's stream
 * error channel instead.
 */
export const normalizeErrorMiddleware = o.middleware(
  async ({ context, next }) => {
    try {
      return await next();
    } catch (error) {
      throw normalizeError(error, context.requestId);
    }
  }
);

export const publicProcedure = o.use(normalizeErrorMiddleware);

export const stream = eventIteratorToUnproxiedDataStream;

export const stream2 = "2";
