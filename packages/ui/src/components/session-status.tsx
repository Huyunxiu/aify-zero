import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"
import { useTranslation } from "react-i18next"

const DoneIcon = (props: ComponentProps<"svg">) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    className="lucide lucide-circle-check preview-icon"
    {...props}
  >
    <circle cx="12" cy="12" r="10" stroke-width="0" />
    <path d="m16 9-5.5 5.5L8 12"/>
  </svg>
)

const IdleIcon = (props: ComponentProps<"svg">) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"
    className="lucide lucide-dot preview-icon"
    {...props}
  >
    <circle cx="12" cy="12" r="2"/>
  </svg>
)

const RunningIcon = (props: ComponentProps<"svg">) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    className="lucide lucide-loader-circle preview-icon"
    {...props}
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
)

const WaitReviewIcon = (props: ComponentProps<"svg">) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none" stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    className="lucide lucide-circle-dot preview-icon"
    {...props}
  >
      <circle cx="12" cy="12" r="1"/>
      <circle cx="12" cy="12" r="10"/>
    </svg>
)

const CanceledIcon = (props: ComponentProps<"svg">) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    className="lucide lucide-circle-x preview-icon"
    {...props}
  >
    <circle cx="12" cy="12" r="10" stroke-width="0" />
    <line x1="9" x2="15" y1="15" y2="9"/>
  </svg>
)

const ErrorIcon = (props: ComponentProps<"svg">) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    className="lucide lucide-circle-x preview-icon"
    {...props}
  >
    <circle cx="12" cy="12" r="10" stroke-width="0" />
    <path d="m15 9-6 6"/>
    <path d="m9 9 6 6"/>
  </svg>
)

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
  | "error";

const STATUS_ICONS: Record<SessionStatus, React.FC<ComponentProps<"svg">>> = {
  idle: IdleIcon,
  running: RunningIcon,
  wait_review: WaitReviewIcon,
  done: DoneIcon,
  canceled: CanceledIcon,
  error: ErrorIcon,
};

const STATUS_STYLES: Record<SessionStatus, string> = {
  idle: "fill-muted-foreground",
  // Spun, not merely tinted: in a list where nothing else moves, the motion is
  // what makes a running turn findable without reading it.
  running: "animate-spin stroke-muted-foreground",
  wait_review: "text-warning",
  done: "text-background fill-primary",
  canceled: "text-background fill-muted-foreground",
  error: "text-background fill-destructive",
};

const STATUS_LABEL_KEYS: Record<SessionStatus, string> = {
  idle: "sessions.status.idle",
  running: "sessions.status.running",
  wait_review: "sessions.status.waitReview",
  done: "sessions.status.done",
  canceled: "sessions.status.canceled",
  error: "sessions.status.error",
};

export type SessionStatusProps = Omit<ComponentProps<"svg">, "children"> & {
  status: SessionStatus;
};

export function SessionStatus({
  status,
  className,
  ...props
}: SessionStatusProps) {
  const { t } = useTranslation();
  const Icon = STATUS_ICONS[status];

  return (
    <Icon
      aria-label={t(STATUS_LABEL_KEYS[status])}
      role="img"
      className={cn("size-3.5 shrink-0", STATUS_STYLES[status], className)}
      {...props}
    />
  );
}
