import type { ErrorMap } from "@orpc/server";
import { createORPCErrorConstructorMap, ORPCError } from "@orpc/server";
import { DEFAULT_ERROR_MESSAGE, ERROR_STATUS } from "@workspace/shared/errors";
import z from "zod";

/**
 * App-specific error definitions. Each entry carries an explicit `status`
 * (custom codes without one fall back to 500) and a default English message.
 *
 * Common codes like NOT_FOUND or BAD_REQUEST are deliberately absent: oRPC
 * recommends plain `ORPCError` for those, since clients already know what they
 * mean and keeping them out of the map keeps type inference cheap.
 *
 * Register an entry on a procedure with `.errors({...})` to get the typed
 * `errors` constructor map inside its handler.
 */
export const errorMap = {
  MODEL_NOT_FOUND: {
    status: ERROR_STATUS.MODEL_NOT_FOUND,
    message: "The requested AI model was not found.",
    data: z.object({ model: z.string() }),
  },
  SESSION_NOT_FOUND: {
    status: ERROR_STATUS.SESSION_NOT_FOUND,
    message: "The requested chat was not found.",
    data: z.object({ sessionId: z.string() }),
  },
  NOTHING_TO_FORK: {
    status: ERROR_STATUS.NOTHING_TO_FORK,
    message: "This chat has nothing to fork.",
  },
  MESSAGE_NOT_FOUND: {
    status: ERROR_STATUS.MESSAGE_NOT_FOUND,
    message: DEFAULT_ERROR_MESSAGE,
  },
} satisfies ErrorMap;

export type AppErrorMap = typeof errorMap;

/** Imperative constructors for the codes above, e.g. `throw errors.MODEL_NOT_FOUND({ data: { model } })`. */
export const errors = createORPCErrorConstructorMap(errorMap);

/**
 * Constructors for the common codes we throw outside of a typed procedure
 * (middleware, normalization). Kept on plain `ORPCError` on purpose — see the
 * note on `errorMap`.
 */
export const commonErrors = {
  badRequest: (message: string) => new ORPCError("BAD_REQUEST", { message }),
  notFound: (message: string) => new ORPCError("NOT_FOUND", { message }),
  internal: (cause?: unknown, requestId?: string) =>
    new ORPCError("INTERNAL_SERVER_ERROR", {
      message: DEFAULT_ERROR_MESSAGE,
      cause,
      data: { requestId },
    }),
};

/**
 * The underlying failure behind a normalized error. Normalization strips
 * details from the client-visible error and stashes them here instead, so the
 * server log can still report what actually went wrong.
 */
export function getErrorCause(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

function isORPCError(error: unknown): error is ORPCError<string, unknown> {
  return error instanceof ORPCError;
}

/**
 * Maps any thrown value onto an `ORPCError`:
 * - an existing `ORPCError` (ours or oRPC's validation error) passes through
 * - everything else becomes an `INTERNAL_SERVER_ERROR`, with the original
 *   error kept as `cause` for the server-side log
 */
export function normalizeError(
  error: unknown,
  requestId?: string
): ORPCError<string, unknown> {
  if (isORPCError(error)) {
    return error;
  }

  return commonErrors.internal(error, requestId);
}
