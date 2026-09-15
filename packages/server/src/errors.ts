import { COMMON_ORPC_ERROR_DEFS } from "@orpc/client";
import type { ErrorMap } from "@orpc/server";
import { createORPCErrorConstructorMap, ORPCError } from "@orpc/server";
import { DEFAULT_ERROR_MESSAGE } from "@workspace/shared/errors";
import z from "zod";

/**
 * The vocabulary of this API: every code it can answer with, what that code
 * means on the wire, and — where it matters — the payload that comes with it.
 *
 * This map is the single source of truth. A code that is not in here is not
 * something we promise to send, so a status and its message live next to the
 * code itself rather than in a second table that could drift away from it.
 *
 * The HTTP-level codes are oRPC's own table rather than a copy of it, so our
 * answer can never disagree with the one the transport would have given on its
 * own.
 *
 * Register an entry on a procedure with `.errors({...})` to get the typed
 * `errors` constructor map inside its handler.
 */
export const errorMap = {
  ...COMMON_ORPC_ERROR_DEFS,

  // App-specific codes: the ones that say something the status alone cannot.
  MODEL_NOT_FOUND: {
    status: 400,
    message: "The requested AI model was not found.",
    data: z.object({ model: z.string() }),
  },
  SESSION_NOT_FOUND: {
    status: 404,
    message: "The requested chat was not found.",
    data: z.object({ sessionId: z.string() }),
  },
  NOTHING_TO_FORK: {
    status: 400,
    message: "This chat has nothing to fork.",
  },
  MESSAGE_NOT_FOUND: {
    status: 404,
    message: DEFAULT_ERROR_MESSAGE,
  },
} satisfies ErrorMap;

/** Every code above, i.e. the whole set a throw site may use. */
export type ErrorCode = keyof typeof errorMap;

export type AppErrorMap = typeof errorMap;

/** Imperative constructors for the codes above, e.g. `throw errors.MODEL_NOT_FOUND({ data: { model } })`. */
export const errors = createORPCErrorConstructorMap(errorMap);

export type ApiErrorOptions<TData = unknown> = {
  /** The underlying failure, kept for the server-side log. */
  cause?: unknown;
  /** Structured payload handed to the client, e.g. the id that was missing. */
  data?: TData;
};

/**
 * What application code throws: plain `Error` semantics, so anything below the
 * oRPC layer — repositories, helpers, middleware — can raise one without
 * importing oRPC. `toORPCError` is the way out, and whoever sits at the
 * transport boundary calls it.
 *
 * The code alone decides what the error means: `status` and the default
 * `message` are read back out of `errorMap` rather than passed in, so a code
 * and its HTTP answer can never drift apart.
 *
 * `data` is the type parameter because it is the only thing a throw site can
 * say something useful about: `new ApiError(code, message, { data: {
 * agentId } })` infers `ApiError<{ agentId: string }>`, while a bare
 * `new ApiError(code)` stays `ApiError<unknown>`.
 */
export class ApiError<TData = unknown> extends Error {
  readonly code: ErrorCode;
  readonly data: TData;

  constructor(
    code: ErrorCode,
    message: string = errorMap[code].message,
    options: ApiErrorOptions<TData> = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    // The `{}` default above means `data` can be absent at runtime even when
    // `TData` is a concrete type, so the widening back is on us.
    this.data = options.data as TData;
  }

  get status(): number {
    return errorMap[this.code].status;
  }

  /**
   * The wire form of this error: same code, status and data, with the
   * `ApiError` kept as `cause` so the server log still points back at the
   * throw site. The payload type travels with it.
   */
  toORPCError(): ORPCError<string, TData> {
    return new ORPCError(this.code, {
      message: this.message,
      status: this.status,
      data: this.data,
      cause: this,
    });
  }
}

/**
 * The underlying failure behind a normalized error. Normalization strips
 * details from the client-visible error and stashes them here instead, so the
 * server log can still report what actually went wrong.
 */
export function getErrorCause(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}
