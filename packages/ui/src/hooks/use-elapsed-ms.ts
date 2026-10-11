import * as React from "react";

const TICK_MS = 1000;

/**
 * Milliseconds from `startedAt` to now, or to `endedAt` once the thing has
 * ended.
 *
 * The interval only exists while `running`, and it stops on its own when the
 * caller flips that flag — so a finished turn, and every turn loaded from the
 * database, render a fixed number and start no timer. Keep this hook in a leaf
 * component: it re-renders its caller once a second, which is cheap for a
 * single span and expensive for a turn's whole step list.
 */
export function useElapsedMs({
  startedAt,
  endedAt,
  running,
}: {
  startedAt: number;
  endedAt?: number;
  running: boolean;
}): number {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!running) {
      return;
    }
    // Read the clock once up front so a freshly started timer does not sit on
    // the value from before it began.
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [running, startedAt]);

  const end = running || endedAt === undefined ? now : endedAt;

  return Math.max(0, end - startedAt);
}
