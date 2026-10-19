import type { AgentToolPart } from "@workspace/agent-client";
import {
  Collapsible,
  CollapsibleContent,
} from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CircleXIcon,
  DotIcon,
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
  onRespondToolApproval?: (approvalId: string, approved: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
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
 * The state a step is in. Colours the whole row, so a chain of finished steps
 * reads as a quiet list and the ones needing attention stand out of it.
 *
 * `approval` is the one state the row cannot resolve on its own — the dialog
 * behind it is where the decision is made.
 */
export type AgentActivityStepStatus =
  | "complete"
  | "running"
  | "failed"
  | "denied"
  | "aborted"
  | "approval";

/**
 * A step's row, and what a click on it does.
 *
 * The row is a button either way — one opens the step's dialog, one selects the
 * step for a pane beside the transcript — so what is spread onto it is a
 * button's props rather than a trigger's.
 */
export type AgentActivityStepProps = ComponentProps<"button"> & {
  path: string;
  icon?: LucideIcon;
  label: ReactNode;
  status?: AgentActivityStepStatus;
  /** A short note on what the step achieved, e.g. `650 lines`. */
  summary?: ReactNode;
  /** How long the step took, right-aligned and set in tabular figures. */
  duration?: ReactNode;
  /**
   * What a click on the row does, when it is not opening the step's own dialog.
   *
   * A `task` call passes this: what it has to show is the subagent's transcript,
   * which is a transcript — too long to read in a dialog, and the thing the
   * reader wants beside the session rather than over it. `children` are not
   * rendered then: there is no dialog left to put them in.
   */
  onSelect?: () => void;
  /** Whether this row is the one the pane is showing. */
  selected?: boolean;
};

interface AgentActivityStepContextType {
  path: string;
}

const AgentActivityStepContext = createContext<AgentActivityStepContextType>({
  path: "",
});

export const AgentActivityStep = memo(
  ({
    path,
    className,
    icon: Icon = DotIcon,
    label,
    status = "complete",
    summary,
    duration,
    onSelect,
    selected,
    children,
    ...props
  }: AgentActivityStepProps) => {
    const { expandedPaths, togglePath } = useAgentActivity();
    const isExpanded = expandedPaths.has(path);

    const handleOpenChange = useCallback(() => {
      togglePath(path);
    }, [togglePath, path]);

    const stepContextValue = useMemo(
      () => ({ isExpanded, path }),
      [isExpanded, path]
    );

    const getStatusIcon = () => {
      // flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ml-1 transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90
      if (status === "running") {
        return <Spinner className="size-3.5 shrink-0" />;
      }

      if (status === "denied") {
        return <CircleXIcon className="size-3.5 text-warning-foreground" />;
      }

      if (status === "failed") {
        return <CircleXIcon className="size-3.5 text-destructive-foreground" />;
      }

      // 被停下来的那一步不是错的，所以用静下来的灰，而不是 failed 的红。
      if (status === "aborted") {
        return (
          <CircleStopIcon className="size-3.5 shrink-0 text-muted-foreground" />
        );
      }

      if (status === "complete") {
        return <CircleCheckIcon className="size-3.5 text-success-foreground" />;
      }

      if (status === "approval") {
        return (
          <ShieldQuestionIcon className="size-3.5 shrink-0 text-warning-foreground" />
        );
      }

      return <div className="size-3.5 shrink-0"></div>;
    };

    const row = (
      <div
        className={cn(
          "group/chain-step relative flex h-7 w-full items-center justify-between gap-2 text-sm transition-colors hover:text-foreground"
        )}
      >
        <div className="flex w-fit max-w-full min-w-0 items-center gap-2 group-hover/chain-step:underline">
          <Icon className="shrink-0 size-4 group-hover/chain-step:hidden" />
          <ArrowUpRightIcon
            className={cn(
              "shrink-0 size-4 transition-transform hidden group-hover/chain-step:block"
            )}
          />
          <span className="min-w-0 text-left truncate">{label}</span>
          {summary && (
            <span className="min-w-0 text-muted-foreground/70 text-xs truncate">
              {summary}
            </span>
          )}
        </div>
        <div className="relative flex h-full items-center gap-2 shrink-0">
          {duration && (
            <span className="shrink-0 font-mono text-muted-foreground/70 text-xs tabular-nums">
              {duration}
            </span>
          )}
          {getStatusIcon()}
        </div>
      </div>
    );

    // A row that selects instead of opening: the same row, clickable, with the
    // step it points at drawn somewhere else. It is a button because that is
    // what it is — the dialog it replaces was one too.
    if (onSelect) {
      return (
        <AgentActivityStepContext.Provider value={stepContextValue}>
          <button
            type="button"
            aria-current={selected ? "true" : undefined}
            onClick={onSelect}
            className={cn(
              "-mx-1.5 flex w-[calc(100%+0.75rem)] flex-col gap-2 rounded-md px-1.5 text-left text-sm outline-none",
              "fade-in-0 slide-in-from-top-2 animate-in",
              selected
                ? "bg-foreground-5 text-foreground"
                : "hover:bg-foreground-3",
              className
            )}
            {...props}
          >
            {row}
          </button>
        </AgentActivityStepContext.Provider>
      );
    }

    return (
      <AgentActivityStepContext.Provider value={stepContextValue}>
        <Dialog open={isExpanded} onOpenChange={handleOpenChange}>
          <DialogTrigger
            className={cn(
              "flex flex-col gap-2 w-full text-sm outline-none",
              "fade-in-0 slide-in-from-top-2 animate-in",
              className
            )}
            {...props}
          >
            {row}
          </DialogTrigger>
          <DialogContent
            className="flex flex-col items-center bg-transparent ring-0 p-0 py-12 sm:max-w-none max-w-none h-dvh overflow-y-scroll"
            showCloseButton={false}
            // 全屏的 popup 盖住了 backdrop，Base UI 的“点击外部关闭”失效了。
            // 命中 popup 自身的空白区域时，就当作点了遮罩。
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                handleOpenChange();
              }
            }}
          >
            <div className="my-auto flex min-w-[70dvw] flex-col gap-4 px-5">
              {children}
            </div>
          </DialogContent>
        </Dialog>
      </AgentActivityStepContext.Provider>
    );
  }
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
AgentActivityStep.displayName = "AgentActivityStep";
AgentActivityContent.displayName = "AgentActivityContent";
