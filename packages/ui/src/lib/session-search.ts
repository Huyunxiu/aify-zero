/**
 * Reads one optional id from the query parameters of a session address.
 *
 * All three ids follow one rule: only a non-empty string counts, and everything
 * else reads as absent. The rule lives here once so the three cannot drift — a
 * missing key and an empty string both mean "none".
 */
const readId = (
  search: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = search[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** Read an optional non-empty `projectId` from session search params. */
export const readProjectId = (
  search: Record<string, unknown>
): string | undefined => readId(search, "projectId");

/** Read an optional non-empty `botId` from session search params. */
export const readBotId = (
  search: Record<string, unknown>
): string | undefined => readId(search, "botId");

/**
 * What a session address can say.
 *
 * The session list and one session are two forms of the same address, so both
 * routes declare this shape. These three keys are all an address carries.
 */
export type SessionSearch = {
  botId?: string;
  projectId?: string;
  subagent?: string;
};

/**
 * Reduces raw query parameters to {@link SessionSearch}.
 *
 * It is also the only builder of that shape: a caller that changes one key
 * spreads its result, so the three keys are named in one place.
 */
export const validateSessionSearch = (
  search: Record<string, unknown>
): SessionSearch => ({
  botId: readBotId(search),
  projectId: readProjectId(search),
  subagent: readSubagentId(search),
});

/**
 * Reads the subagent that the session panel is showing.
 *
 * The value is a selection, not a visibility: it says which subagent the reader
 * still wants, whether or not its tab is the active one. A panel that mounts
 * with a selection builds that tab and activates it.
 */
export const readSubagentId = (
  search: Record<string, unknown>
): string | undefined => readId(search, "subagent");
