/**
 * The reading column and the writing column of a session.
 *
 * One screen shows one column. Both the record and the composer take it from
 * here, so the two cannot drift apart at a breakpoint. The gutter belongs to
 * the column, not to the scroll container: the scroll bar stays at the edge of
 * the pane, while no record touches that edge.
 *
 * A caller adds its own vertical rhythm. It must not add another `max-w` or
 * horizontal padding.
 */
export const SESSION_COLUMN = "mx-auto flex w-full max-w-4xl flex-col px-4";
