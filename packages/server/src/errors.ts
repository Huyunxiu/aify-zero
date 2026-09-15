import { COMMON_ORPC_ERROR_DEFS } from "@orpc/client";
import type {
  ErrorMap as ErrorMapType,
  InferSchemaOutput,
  Schema,
} from "@orpc/server";
import { createORPCErrorConstructorMap, ORPCError } from "@orpc/server";
import type { Language } from "@workspace/shared/constants";
import z from "zod";

import { errorMessage } from "./i18n";

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
export const ErrorMap = {
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
    message: "The requested message was not found.",
    // `messageId` is optional because the throw site has no id to name when
    // the client asked for the branch as a whole and there is nothing in it.
    data: z.object({ sessionId: z.string(), messageId: z.string().optional() }),
  },
} satisfies ErrorMapType;

/** Every code above, i.e. the whole set a throw site may use. */
export type ErrorCode = keyof typeof ErrorMap;

/**
 * The payload a code carries, read back out of the schema `ErrorMap` declares
 * for it — `unknown` for a code that declares none.
 */
export type ErrorDataOf<TCode extends ErrorCode> =
  (typeof ErrorMap)[TCode] extends {
    data: infer TSchema extends Schema<any, any>;
  }
    ? InferSchemaOutput<TSchema>
    : unknown;

/** Imperative constructors for the codes above, e.g. `throw errors.MODEL_NOT_FOUND({ data: { model } })`. */
export const errors = createORPCErrorConstructorMap(ErrorMap);

export type ApiErrorOptions<TCode extends ErrorCode = ErrorCode> = {
  /** Overrides the message the code declares. Rarely needed. */
  message?: string;
  /** The underlying failure, kept for the server-side log. */
  cause?: unknown;
  /** Structured payload handed to the client, e.g. the id that was missing. */
  data?: ErrorDataOf<TCode>;
};

/**
 * What application code throws: plain `Error` semantics, so anything below the
 * oRPC layer — repositories, helpers, middleware — can raise one without
 * importing oRPC. `toORPCError` is the way out, and whoever sits at the
 * transport boundary calls it.
 *
 * The code alone decides what the error means: `status` and the default
 * `message` are read back out of `ErrorMap` rather than passed in, so a code
 * and its HTTP answer can never drift apart. A `message` in the options
 * overrides that default, for the few cases where the caller knows better.
 *
 * Which message the client ends up reading follows from who wrote it. An
 * explicit one is the caller's own words — it says something the code cannot,
 * and there is no translation for it — so it goes out verbatim. An error that
 * inherits the default goes out translated, in the language the request asked
 * for (see `getLocalizedMessage`). `this.message` is always the authored one,
 * so the server's own log reads the same whoever asked.
 *
 * Everything after the code travels in one options object rather than in
 * positional arguments, so a call site that only carries `data` does not have
 * to say anything about the message it is happy to inherit:
 *
 *   throw new ApiError("MODEL_NOT_FOUND", { data: { model } });
 *
 * The code is the type parameter, and the payload follows from it: `data` is
 * typed by the schema `ErrorMap` declares for that code, so the call above is
 * an `ApiError<"MODEL_NOT_FOUND">` whose `data` is `{ model: string }` — the
 * same schema the client's error type is derived from. A code that declares no
 * schema, such as `NOTHING_TO_FORK`, has nothing to check against and takes
 * `data: unknown`.
 *
 * `data` is optional at every call site, so an error that carries nothing
 * beyond its code is just `new ApiError("NOTHING_TO_FORK")`. The property says
 * as much by being `| undefined`, hence `error.data?.model` where it is read.
 */
export class ApiError<TCode extends ErrorCode = ErrorCode> extends Error {
  readonly code: TCode;
  readonly data: ErrorDataOf<TCode> | undefined;

  /**
   * The message the call site wrote, if it wrote one. Kept apart from
   * `message` rather than compared against the code's default, so passing the
   * very same string as the default still counts as the caller's own words.
   */
  private readonly ownMessage: string | undefined;

  constructor(code: TCode, options: ApiErrorOptions<TCode> = {}) {
    super(options.message ?? ErrorMap[code].message, { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.data = options.data;
    this.ownMessage = options.message;
  }

  get status(): number {
    return ErrorMap[this.code].status;
  }

  /**
   * What the client reads: the caller's own message when there is one, and
   * otherwise what this code says in `language`.
   */
  getLocalizedMessage(language: Language): string {
    return this.ownMessage ?? errorMessage(language, this.code);
  }

  /**
   * The wire form of this error: same code, status and data, with the
   * `ApiError` kept as `cause` so the server log still points back at the
   * throw site. The payload type travels with it, and the message is the one
   * `language` asks for.
   */
  toORPCError(
    language: Language
  ): ORPCError<TCode, ErrorDataOf<TCode> | undefined> {
    return new ORPCError(this.code, {
      message: this.getLocalizedMessage(language),
      status: this.status,
      data: this.data,
      cause: this,
    });
  }
}
