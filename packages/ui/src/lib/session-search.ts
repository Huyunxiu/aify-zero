/** Read an optional non-empty `projectId` from session search params. */
export const readProjectId = (
  search: Record<string, unknown>
): string | undefined =>
  typeof search.projectId === "string" && search.projectId !== ""
    ? search.projectId
    : undefined;

/** Read an optional non-empty `botId` from session search params. */
export const readBotId = (
  search: Record<string, unknown>
): string | undefined =>
  typeof search.botId === "string" && search.botId !== ""
    ? search.botId
    : undefined;
