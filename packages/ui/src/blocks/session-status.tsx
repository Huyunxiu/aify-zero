import { cn } from "@workspace/ui/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The session lifecycle states the server stores.
 *
 * Spelled out rather than imported from `@workspace/db`: the renderer has no
 * dependency on the schema package, and reaching into it for one union would
 * tie the two together. The duplication checks itself — callers pass the
 * server's own `status`, so a state added there stops type-checking at every
 * call site until it is added here too.
 */
export type SessionStatus =
  | "idle"
  | "running"
  | "wait_review"
  | "done"
  | "canceled"
  | "timed-out"
  | "error";

const DISC_RADIUS = 10;

/** The shape of "a turn waits for the reader": a bold ring and a core. */
const RING_RADIUS = 8.4;
const RING_STROKE = 2.8;
const CORE_RADIUS = 3.6;

const RUNNING = <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth="2" />;

const WAIT_REVIEW = (
  <>
    <circle
      cx="12"
      cy="12"
      r={RING_RADIUS}
      fill="none"
      strokeWidth={RING_STROKE}
    />
    <circle cx="12" cy="12" r={CORE_RADIUS} stroke="none" />
  </>
);

const DONE = (
  <>
    <circle cx="12" cy="12" r={DISC_RADIUS} strokeWidth="0" />
    <path d="m16 9-5.5 5.5L8 12" fill="none" strokeWidth="2" />
  </>
);

const CANCELED = (
  <>
    <circle cx="12" cy="12" r={DISC_RADIUS} strokeWidth="0" />
    <line x1="9" x2="15" y1="15" y2="9" strokeWidth="2" />
  </>
);

/** A clock face: no one stopped this run, the limit did. */
const TIMED_OUT = (
  <>
    <circle cx="12" cy="12" r={DISC_RADIUS} strokeWidth="0" />
    <circle
      cx="12"
      cy="12"
      r={RING_RADIUS}
      fill="none"
      strokeWidth={RING_STROKE}
    />
    <path d="M12 7.6v4.9l3.2 1.9" fill="none" strokeWidth="1.8" />
  </>
);

const ERROR = (
  <>
    <circle cx="12" cy="12" r={DISC_RADIUS} strokeWidth="0" />
    <path d="m15 9-6 6" fill="none" strokeWidth="2" />
    <path d="m9 9 6 6" fill="none" strokeWidth="2" />
  </>
);

/**
 * Colour goes through `fill-*` and `stroke-*`, never `text-*`.
 *
 * A sidebar row paints `text-sidebar-accent-foreground` on every direct `svg`
 * child, and that rule outranks a class on the icon itself. A `text-*` colour
 * added here would be lost without an error — which is how `wait_review` used
 * to render without its amber.
 */
const STATUS_STYLES: Record<SessionStatus, string> = {
  idle: "",
  // Spun, not merely tinted: in a list where nothing else moves, the motion is
  // what makes a running turn findable without reading it.
  running: "animate-spin stroke-muted-foreground motion-reduce:animate-none",
  wait_review: "stroke-warning fill-warning",
  done: "fill-primary stroke-white",
  canceled: "fill-muted-foreground stroke-white",
  "timed-out": "fill-muted-foreground stroke-white",
  error: "fill-destructive stroke-white",
};

const STATUS_MARKS: Record<SessionStatus, ReactNode> = {
  idle: null,
  running: RUNNING,
  wait_review: WAIT_REVIEW,
  done: DONE,
  canceled: CANCELED,
  "timed-out": TIMED_OUT,
  error: ERROR,
};

const STATUS_LABEL_KEYS = {
  idle: "sessions.status.idle",
  running: "sessions.status.running",
  wait_review: "sessions.status.waitReview",
  done: "sessions.status.done",
  canceled: "sessions.status.canceled",
  "timed-out": "sessions.status.timedOut",
  error: "sessions.status.error",
} as const satisfies Record<SessionStatus, string>;

export type SessionStatusProps = Omit<ComponentProps<"svg">, "children"> & {
  status: SessionStatus;
};

/**
 * The status of one session: a filled disc with a white mark on it.
 *
 * White on `primary`, on `muted-foreground` and on `destructive` reads the same
 * in both themes, so the mark needs no colour of its own and no knowledge of
 * what the row paints behind it. `idle` draws nothing — a session that has not
 * started has nothing to report, and the empty box keeps the titles in one
 * column.
 */
export function SessionStatus({
  status,
  className,
  ...props
}: SessionStatusProps) {
  const { t } = useTranslation();

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label={t(STATUS_LABEL_KEYS[status])}
      role="img"
      className={cn("size-3.5 shrink-0", STATUS_STYLES[status], className)}
      {...props}
    >
      {STATUS_MARKS[status]}
    </svg>
  );
}
