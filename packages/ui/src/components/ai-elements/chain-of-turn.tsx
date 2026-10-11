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
  CircleXIcon,
  DotIcon,
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

/**
 * The state a step is in. Colours the whole row, so a chain of finished steps
 * reads as a quiet list and the ones needing attention stand out of it.
 */
export type AgentActivityStepStatus =
  | "complete"
  | "running"
  | "failed"
  | "denied";

export type AgentActivityStepProps = ComponentProps<typeof DialogTrigger> & {
  path: string;
  icon?: LucideIcon;
  label: ReactNode;
  status?: AgentActivityStepStatus;
  /** A short note on what the step achieved, e.g. `650 lines`. */
  summary?: ReactNode;
  /** How long the step took, right-aligned and set in tabular figures. */
  duration?: ReactNode;
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
            <div
              className={cn(
                "group/chain-step relative flex h-7 w-full items-center justify-between gap-2 text-sm transition-colors hover:text-foreground"
              )}
            >
              <div className="relative flex h-full items-center gap-2 flex-1 group-hover/chain-step:underline">
                <Icon className="shrink-0 size-4 group-hover/chain-step:hidden" />
                <ArrowUpRightIcon
                  className={cn(
                    "shrink-0 size-4 transition-transform hidden group-hover/chain-step:block"
                  )}
                />
                <span className="min-w-0 text-left">{label}</span>
                {summary && (
                  <span className="min-w-0 text-muted-foreground/70 text-xs">
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
                {status === "running" && (
                  <Spinner className="size-3.5 shrink-0" />
                )}
                {status === "denied" && (
                  <CircleXIcon className="size-3.5 text-warning-foreground" />
                )}
                {status === "failed" && (
                  <CircleXIcon className="size-3.5 text-destructive-foreground" />
                )}
                {status === "complete" && (
                  <CircleCheckIcon className="size-3.5 text-success-foreground" />
                )}
              </div>
            </div>
          </DialogTrigger>
          <DialogContent
            className="bg-transparent ring-0 px-0 py-0 min-w-[72vw]"
            showCloseButton={false}
          >
            <div className="flex max-h-[calc(100dvh-2*min(10vh,10rem))] flex-col gap-4 overflow-y-auto overscroll-contain px-5">
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
    role="details"
    {...props}
  >
    {children}
  </div>
);

AgentActivity.displayName = "AgentActivity";
AgentActivityHeader.displayName = "AgentActivityHeader";
AgentActivityStep.displayName = "AgentActivityStep";
AgentActivityContent.displayName = "AgentActivityContent";
