// Shared error vocabulary and wire-format helpers.
//
// This module is intentionally dependency-free: the agent package needs to tag
// errors emitted inside a stream, but it cannot import the server package (that
// would be a cycle). Everything here is plain constants and structural type
// guards, so the same helpers serve the oRPC transport, the AI SDK stream error
// channel, and the Electron IPC surface.

export const ErrorCode = {
  // Common oRPC codes — clients already know what these mean, so they are not
  // registered in the server ErrorMap (oRPC recommends plain ORPCError for them).
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",

  // App-specific codes — these carry typed `data` and are declared per
  // procedure via `.errors({...})`.
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  MESSAGE_NOT_FOUND: "MESSAGE_NOT_FOUND",
  NOTHING_TO_FORK: "NOTHING_TO_FORK",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL_SERVER_ERROR: 500,

  MODEL_NOT_FOUND: 400,
  SESSION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  NOTHING_TO_FORK: 400,
};

export const DEFAULT_ERROR_MESSAGE =
  "Something went wrong. Please try again later.";

export type NormalizedError = {
  code: string;
  message: string;
  status?: number;
  data?: unknown;
};

export type ParseErrorOptions = {
  fallbackMessage?: string;
};

/**
 * The single normalization entry point on the client: accepts an ORPCError (or
 * anything shaped like one), a plain `Error`, or the `Error` that `useChat`
 * builds from a stream error envelope, and always returns a usable shape.
 */
export function parseError(
  error: unknown,
  options: ParseErrorOptions = {}
): NormalizedError {
  const fallbackMessage = options.fallbackMessage ?? DEFAULT_ERROR_MESSAGE;

  if (typeof error === "string") {
    return {
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: error || fallbackMessage,
    };
  }

  if (error instanceof Error) {
    return {
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: error.message || fallbackMessage,
    };
  }

  return {
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    message: fallbackMessage,
  };
}
