/**
 * The shape of a subagent name, and how one is chosen.
 *
 * The name is the only address a parent session holds: the model gets the name
 * and never the session id. It is scoped to the parent, so two parents can each
 * hold `AGENT-1`; it is fixed when the row is written; and it is never reused.
 * The number runs to the first free one, so two delegations in flight are settled
 * by the unique index: the loser recomputes.
 */

const NAME_PREFIX = "AGENT-";

/** The name for the n-th subagent of one parent session. */
export function formatSubagentName(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`a subagent number starts at 1, got ${n}`);
  }

  return `${NAME_PREFIX}${n}`;
}

/**
 * The first free name under one parent session.
 *
 * A child written before names existed holds no name, so it competes for none of
 * them. A gap left by a delete is filled before a new number is made, because the
 * number carries nothing a reader should count on.
 */
export function nextSubagentName(used: readonly (string | null)[]): string {
  const taken = new Set(used.filter((name): name is string => name !== null));

  let n = 1;
  while (taken.has(formatSubagentName(n))) {
    n += 1;
  }

  return formatSubagentName(n);
}

/**
 * Fold what a model typed into the form the row holds.
 *
 * A name is matched by equality on an indexed column, so the fold happens to the
 * caller's string, never to the column.
 */
export function normalizeSubagentName(input: string): string {
  return input.trim().toUpperCase();
}
