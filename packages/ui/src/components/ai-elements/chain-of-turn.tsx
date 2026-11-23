import type { AgentToolPart, JSONObject } from "@workspace/agent-client";
import {
  Collapsible,
  CollapsibleContent,
} from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CircleXIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { Button } from "../button";
import { Dialog, DialogContent, DialogTrigger } from "../dialog";
import { Spinner } from "../spinner";
import { LoaderGrid, PATTERNS } from "./loading-state";

interface AgentActivityContext {
  expandedPaths: Set<string>;
  togglePath: (path: string) => void;
}

// Default noop for context default value
// oxlint-disable-next-line no-empty-function
const noop = () => {};

const AgentActivityContext = createContext<AgentActivityContext | null>({
  expandedPaths: new Set(),
  togglePath: noop,
});

const useAgentActivity = () => {
  const context = useContext(AgentActivityContext);
  if (!context) {
    throw new Error(
      "AgentActivity components must be used within AgentActivity"
    );
  }
  return context;
};

/**
 * The fold around one turn's steps.
 *
 * It keeps the open state of the turn-level parts — the header and the content
 * below it. The steps in that content keep their own, so a step is usable
 * outside this provider.
 */
export type AgentActivityProps = ComponentProps<"div"> & {
  expanded?: Set<string>;
  defaultExpanded?: Set<string>;
  onExpandedChange?: (expanded: Set<string>) => void;
};

export const AgentActivity = memo(
  ({
    expanded: controlledExpanded,
    defaultExpanded = new Set(),
    onExpandedChange,
    className,
    children,
    ...props
  }: AgentActivityProps) => {
    const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
    const expandedPaths = controlledExpanded ?? internalExpanded;

    const togglePath = useCallback(
      (path: string) => {
        const newExpanded = new Set(expandedPaths);
        if (newExpanded.has(path)) {
          newExpanded.delete(path);
        } else {
          newExpanded.add(path);
        }
        setInternalExpanded(newExpanded);
        onExpandedChange?.(newExpanded);
      },
      [expandedPaths, onExpandedChange]
    );

    const contextValue = useMemo(
      () => ({ expandedPaths, togglePath }),
      [expandedPaths, togglePath]
    );

    return (
      <AgentActivityContext.Provider value={contextValue}>
        <div className={cn("not-prose w-full", className)} {...props}>
          {children}
        </div>
      </AgentActivityContext.Provider>
    );
  }
);

export type AgentActivityHeaderProps = ComponentProps<"div"> & {
  path: string;
  loading?: boolean;
  /** A note on what the turn as a whole did, after the title. */
  summary?: ReactNode;
  /** How long the turn took, right-aligned and set in tabular figures. */
  duration?: ReactNode;
};

export const AgentActivityHeader = memo(
  ({
    path,
    loading,
    summary,
    duration,
    className,
    children,
    ...props
  }: AgentActivityHeaderProps) => {
    const { expandedPaths, togglePath } = useAgentActivity();
    const isExpanded = expandedPaths.has(path);

    const handleOpenChange = useCallback(() => {
      togglePath(path);
    }, [togglePath, path]);

    return (
      <div
        className={cn(
          "group/chain-header flex h-7 w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground cursor-pointer",
          className
        )}
        onClick={handleOpenChange}
        {...props}
      >
        {loading ? (
          <>
            <div className={cn("size-4 group-hover/chain-header:hidden")}>
              <LoaderGrid {...PATTERNS.Drive} />
            </div>
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform hidden group-hover/chain-header:block",
                isExpanded ? "rotate-0" : "-rotate-90"
              )}
            />
          </>
        ) : (
          <ChevronDownIcon
            className={cn(
              "size-4 transition-transform",
              isExpanded ? "rotate-0" : "-rotate-90"
            )}
          />
        )}
        <span className={cn("text-left", { shimmer: loading })}>
          {children ?? "Chain of Turn"}
        </span>
        {summary && (
          <span className="min-w-0 truncate text-muted-foreground/70 text-xs">
            {summary}
          </span>
        )}
        {duration && (
          <span className="ml-auto shrink-0 font-mono text-muted-foreground/70 text-xs tabular-nums">
            {duration}
          </span>
        )}
      </div>
    );
  }
);

export type AgentActivityApprovalProps = {
  className?: string;
  part: AgentToolPart;
  onRespondToolApproval?: (
    approvalId: string,
    approved: boolean,
    answer?: ToolApprovalAnswer
  ) => void;
  title?: ReactNode;
  description?: ReactNode;
};

/**
 * What an answer carries besides the decision.
 *
 * `reason` is the human-readable note stored with the approval; `data` is the
 * application's own JSON, kept on the approval rather than sent to the model.
 * A questionnaire puts its submitted answers in `data`; the generic approve and
 * deny buttons pass neither.
 */
export type ToolApprovalAnswer = {
  reason?: string;
  data?: JSONObject;
};

/**
 * The decision a held step is asking for, shown at the top of the step's own
 * dialog — the call's input sits below it, which is what there is to review.
 *
 * A request is answered once, so the buttons go out together: the second is
 * locked while the first is in flight, and the panel turns into a read-only
 * result as soon as the answer comes back and rewrites `approved`.
 */
export const AgentActivityApproval = ({
  part,
  onRespondToolApproval,
  title,
  description,
  className,
}: AgentActivityApprovalProps) => {
  if (!part.approval || part.approval.approved !== undefined) {
    return;
  }

  return (
    <div className="pl-6 pb-0.5 pr-0.5">
      <div
        className={cn(
          "relative flex flex-col rounded-[calc(var(--radius-xl)-2px)] bg-background overflow-hidden shadow-2xs",
          className
        )}
      >
        <div
          className={cn("font-medium text-sm text-accent-foreground p-3", {
            "pb-0": description,
          })}
        >
          {title || "Do you want proceed?"}
        </div>
        {description && (
          <div className="mt-1.5 text-sm leading-relaxed text-ink-2 p-3 pt-0">
            <div className="whitespace-pre">{description}</div>
          </div>
        )}

        <div className="p-2.5 flex items-center justify-between gap-3 border-t">
          <div className="flex items-center gap-2">
            <Button
              variant={part.approval.approved === true ? "success" : "default"}
              onClick={() => onRespondToolApproval?.(part.approval!.id, true)}
              size="sm"
            >
              {part.approval.approved ? "Approved" : "Approve"}
            </Button>
            {part.approval.approved === undefined && (
              <Button
                onClick={() =>
                  onRespondToolApproval?.(part.approval!.id, false)
                }
                size="sm"
                variant="outline"
              >
                Deny
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * The states a step row can draw. The row colours its status icon by this, so a
 * chain of finished steps reads as a quiet list and the ones needing attention
 * stand out of it.
 *
 * It is not a tool part's own `state`: `output-available` covers both a success
 * and a failure the tool reported, and the row must tell those apart. `aborted`
 * is the third way a call ends without a result — its turn stopped. It is not
 * `failed`, because nothing went wrong.
 *
 * `approval` is the one state the step cannot resolve on its own — the dialog
 * behind it is where the decision is made.
 */
export type AgentStepStatus =
  | "complete"
  | "running"
  | "failed"
  | "denied"
  | "aborted"
  | "approval";

interface AgentStepContextValue {
  close: () => void;
}

const AgentStepContext = createContext<AgentStepContextValue>({ close: noop });

const useAgentStep = () => useContext(AgentStepContext);

/**
 * One step of a turn, made of parts.
 *
 * The shape follows shadcn's `Trace`: the step holds its own open state, the
 * caller builds the row from children, and no part takes a path. The styles
 * stay this package's own, so a step opens a dialog over the transcript and
 * does not unfold inside it.
 *
 * - `AgentStep` holds the open state and the dialog.
 * - `AgentStepTrigger` opens that dialog.
 * - `AgentStepContent` is what the dialog shows.
 * - `AgentStepRow` is the visual row. `AgentStepIcon`, `AgentStepTitle`, and
 *   `AgentStepDescription` fill its left half.
 * - `AgentStepButton` points a pane beside the transcript at this step. Use it
 *   for a step whose detail is a transcript of its own, too long for a dialog.
 *
 * An `AgentStep` inside `AgentStepContent` is a step of that step. The parts
 * nest by structure, so no depth needs an API of its own.
 *
 * `AgentStep` renders no element of its own: it is the dialog root. The trigger
 * and the content keep the dialog primitive's `data-slot`, because other
 * components select on it, and add `data-step-part` to say which part they are.
 */
export type AgentStepProps = {
  defaultOpen?: boolean;
  children?: ReactNode;
} & (
  | { open?: undefined; onOpenChange?: (open: boolean) => void }
  | { open: boolean; onOpenChange: (open: boolean) => void }
);

export const AgentStep = ({
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  children,
}: AgentStepProps) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlledOpen ?? internalOpen;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) {
        setInternalOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );

  const close = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  const contextValue = useMemo(() => ({ close }), [close]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <AgentStepContext.Provider value={contextValue}>
        {children}
      </AgentStepContext.Provider>
    </Dialog>
  );
};

export type AgentStepTriggerProps = ComponentProps<typeof DialogTrigger>;

/** The row as a dialog trigger: one click opens what `AgentStepContent` holds. */
export const AgentStepTrigger = ({
  className,
  children,
  ...props
}: AgentStepTriggerProps) => (
  <DialogTrigger
    data-step-part="trigger"
    className={cn(
      "flex flex-col gap-2 w-full text-sm outline-none",
      "fade-in-0 slide-in-from-top-2 animate-in",
      className
    )}
    {...props}
  >
    {children}
  </DialogTrigger>
);

export type AgentStepContentProps = ComponentProps<typeof DialogContent>;

/**
 * What the dialog shows.
 *
 * The popup is full-screen and transparent, so the content is what the reader
 * sees. A press on the popup's own empty area counts as a press on the
 * backdrop. The full-screen popup covers that backdrop.
 */
export const AgentStepContent = ({
  className,
  children,
  onClick,
  ...props
}: AgentStepContentProps) => {
  const { close } = useAgentStep();

  return (
    <DialogContent
      data-step-part="content"
      className={cn(
        "flex flex-col items-center bg-transparent ring-0 p-0 py-12 sm:max-w-none max-w-none h-dvh overflow-y-scroll",
        className
      )}
      showCloseButton={false}
      size="large"
      onClick={(event) => {
        onClick?.(event);
        if (event.target === event.currentTarget) {
          close();
        }
      }}
      {...props}
    >
      <div className="my-auto flex min-w-[80dvw] max-w-[80dvw] flex-col gap-4 px-5">
        {children}
      </div>
    </DialogContent>
  );
};

export type AgentStepRowProps = ComponentProps<"div"> & {
  status?: AgentStepStatus;
  /** How long the step took, right-aligned and set in tabular figures. */
  duration?: ReactNode;
};

/**
 * The visual row: children fill the left half, `duration` and the status icon
 * take the right one.
 *
 * It is a plain box, not a trigger. A step that opens a dialog puts it in
 * `AgentStepTrigger`. A step that selects a pane puts it in `AgentStepButton`.
 */
export const AgentStepRow = ({
  status = "complete",
  duration,
  className,
  children,
  ...props
}: AgentStepRowProps) => (
  <div
    data-slot="agent-step-row"
    data-status={status}
    className={cn(
      "group/agent-step-row relative flex h-7 w-full items-center justify-between gap-2 text-sm transition-colors hover:text-foreground",
      className
    )}
    {...props}
  >
    <div className="flex w-fit max-w-full min-w-0 items-center gap-2 group-hover/agent-step-row:underline">
      {children}
    </div>
    <div className="relative flex h-full items-center gap-2 shrink-0">
      {duration && (
        <span className="shrink-0 font-mono text-muted-foreground/70 text-xs tabular-nums">
          {duration}
        </span>
      )}
      <AgentStepStatusIcon status={status} />
    </div>
  </div>
);

const AgentStepStatusIcon = ({ status }: { status: AgentStepStatus }) => {
  if (status === "running") {
    return <Spinner className="size-3.5 shrink-0" />;
  }

  if (status === "denied") {
    return <CircleXIcon className="size-3.5 text-warning-foreground" />;
  }

  if (status === "failed") {
    return <CircleXIcon className="size-3.5 text-destructive-foreground" />;
  }

  // A step that was stopped is not a step that went wrong, so it gets the quiet
  // grey and not the failed red.
  if (status === "aborted") {
    return (
      <CircleStopIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  }

  if (status === "approval") {
    return (
      <ShieldQuestionIcon className="size-3.5 shrink-0 text-warning-foreground" />
    );
  }

  if (status === "complete") {
    return <CircleCheckIcon className="size-3.5 text-success-foreground" />;
  }

  // Not reachable through the type, which names all six states. It keeps the
  // right-hand side from collapsing if a bad value arrives at run time.
  return <div className="size-3.5 shrink-0" />;
};

/**
 * The step's leading icon, and the arrow that says the row can be opened.
 *
 * They are one slot. On hover, the arrow replaces the icon. This is the
 * affordance the row has always had.
 */
export const AgentStepIcon = ({
  className,
  children,
  ...props
}: ComponentProps<"span">) => (
  <>
    <span
      data-slot="agent-step-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:shrink-0 group-hover/agent-step-row:hidden",
        className
      )}
      {...props}
    >
      {children}
    </span>
    <ArrowUpRightIcon className="shrink-0 size-4 transition-transform hidden group-hover/agent-step-row:block" />
  </>
);

export type AgentStepTitleProps = ComponentProps<"span">;

export const AgentStepTitle = ({
  className,
  ...props
}: AgentStepTitleProps) => (
  <span
    data-slot="agent-step-title"
    className={cn("min-w-0 text-left truncate", className)}
    {...props}
  />
);

export type AgentStepDescriptionProps = ComponentProps<"span">;

/** A short note on what the step achieved, e.g. `650 lines`. */
export const AgentStepDescription = ({
  className,
  ...props
}: AgentStepDescriptionProps) => (
  <span
    data-slot="agent-step-description"
    className={cn(
      "min-w-0 text-muted-foreground/70 text-xs truncate",
      className
    )}
    {...props}
  />
);

export type AgentStepButtonProps = ComponentProps<"button"> & {
  /** Whether this row is the one the pane is showing. */
  selected?: boolean;
};

/**
 * The row as a selection. It points the pane beside the transcript at this
 * step, and it does not open a dialog.
 *
 * It is a button and not a dialog trigger, because the step it points at is
 * drawn somewhere else.
 */
export const AgentStepButton = ({
  selected,
  className,
  children,
  ...props
}: AgentStepButtonProps) => (
  <button
    type="button"
    data-slot="agent-step-button"
    aria-current={selected ? "true" : undefined}
    className={cn(
      "-mx-1.5 flex w-[calc(100%+0.75rem)] flex-col gap-2 rounded-md px-1.5 text-left text-sm outline-none",
      "fade-in-0 slide-in-from-top-2 animate-in",
      selected ? "bg-muted" : "hover:bg-muted",
      className
    )}
    {...props}
  >
    {children}
  </button>
);

export type AgentActivityContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  path: string;
};

export const AgentActivityContent = memo(
  ({ path, className, children, ...props }: AgentActivityContentProps) => {
    const { expandedPaths, togglePath } = useAgentActivity();
    const isExpanded = expandedPaths.has(path);

    const handleOpenChange = useCallback(() => {
      togglePath(path);
    }, [togglePath, path]);

    return (
      <Collapsible onOpenChange={handleOpenChange} open={isExpanded}>
        <CollapsibleContent
          className={cn(
            "mt-1 space-y-1",
            "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
            className
          )}
          {...props}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    );
  }
);

export type AgentActivityActionsProps = ComponentProps<"div">;

const stopPropagation = (e: React.SyntheticEvent) => {
  e.stopPropagation();
};

export const AgentActivityActions = ({
  className,
  children,
  ...props
}: AgentActivityActionsProps) => (
  <div
    className={cn("ml-auto flex items-center gap-1", className)}
    onClick={stopPropagation}
    onKeyDown={stopPropagation}
    {...props}
  >
    {children}
  </div>
);

AgentActivity.displayName = "AgentActivity";
AgentActivityHeader.displayName = "AgentActivityHeader";
AgentActivityApproval.displayName = "AgentActivityApproval";
AgentActivityContent.displayName = "AgentActivityContent";
