/**
 * The project a new session starts in, read from the address.
 *
 * A project row opens a new session with `?projectId=…` on the session
 * address. The value is optional: the global "new session" action omits it and
 * the server falls back to the default project.
 *
 * The route validates the search with this function and the session host reads
 * it with the same one, so the rule has one home.
 */
export const readProjectId = (
  search: Record<string, unknown>
): string | undefined =>
  typeof search.projectId === "string" && search.projectId !== ""
    ? search.projectId
    : undefined;
