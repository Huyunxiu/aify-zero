/**
 * The underlying failure behind a normalized error. Normalization strips
 * details from the client-visible error and stashes them here instead, so the
 * server log can still report what actually went wrong.
 */
export function getErrorCause(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

export function getErrorMessage(error: unknown | undefined) {
  if (!error) {
    return;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return JSON.stringify(error);
}
