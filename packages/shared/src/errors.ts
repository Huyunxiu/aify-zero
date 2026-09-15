// Shared error helpers for the receiving side of the wire.
//
// The vocabulary itself — which codes exist, their status, their message —
// lives in the server's `errorMap`, which owns it. This module only knows how
// to turn whatever the transport handed back into something displayable, and
// it stays dependency-free so the same helpers serve the oRPC transport, the
// AI SDK stream error channel, and the Electron IPC surface.

/** What every failure we cannot classify is reported as. */
const INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR";

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
      code: INTERNAL_SERVER_ERROR,
      message: error || fallbackMessage,
    };
  }

  if (error instanceof Error) {
    return {
      code: INTERNAL_SERVER_ERROR,
      message: error.message || fallbackMessage,
    };
  }

  return {
    code: INTERNAL_SERVER_ERROR,
    message: fallbackMessage,
  };
}
