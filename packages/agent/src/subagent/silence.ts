/**
 * The children a parent takes with it when it stops.
 *
 * A child stopped because its parent stopped has nobody left to tell: the
 * parent's run is over, and its next turn should not begin by reading news
 * about a stop the user asked for. The session layer marks the children it is
 * about to stop; the settlement that follows consumes the mark and writes no
 * notice.
 *
 * A child that was not running leaves its mark behind — nothing settles, so
 * nothing consumes it. The same stop clears the leftovers, or a child messaged
 * again next week would settle in silence.
 *
 * The mark lives in the process, like the registry that holds the runs it comes
 * from: a stop is a fact about live runs, and a run does not survive a restart.
 */
const SILENCED = new Set<string>();

/** The next settlement of this child writes no notice. */
export const silenceSettlement = (childSessionId: string): void => {
  SILENCED.add(childSessionId);
};

/** Whether this settlement stays quiet, consuming the mark. */
export const takeSilence = (childSessionId: string): boolean =>
  SILENCED.delete(childSessionId);

/** Drop a mark whose child never settled. */
export const clearSilence = (childSessionId: string): void => {
  SILENCED.delete(childSessionId);
};
