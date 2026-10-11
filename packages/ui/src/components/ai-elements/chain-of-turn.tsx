import {
  Collapsible,
  CollapsibleContent,
} from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRightIcon, ChevronDownIcon, DotIcon } from "lucide-react";
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

interface ChainOfTurnContext {
  expandedPaths: Set<string>;
  togglePath: (path: string) => void;
}

// Default noop for context default value
// oxlint-disable-next-line no-empty-function
const noop = () => {};

const ChainOfTurnContext = createContext<ChainOfTurnContext | null>({
  expandedPaths: new Set(),
  togglePath: noop,
});

const useChainOfTurn = () => {
  const context = useContext(ChainOfTurnContext);
  if (!context) {
    throw new Error("ChainOfTurn components must be used within ChainOfTurn");
  }
  return context;
};

export type ChainOfTurnProps = ComponentProps<"div"> & {
  expanded?: Set<string>;
  defaultExpanded?: Set<string>;
  onExpandedChange?: (expanded: Set<string>) => void;
};

export const ChainOfTurn = memo(
  ({
    expanded: controlledExpanded,
    defaultExpanded = new Set(),
    onExpandedChange,
    className,
    children,
    ...props
  }: ChainOfTurnProps) => {
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
      <ChainOfTurnContext.Provider value={contextValue}>
        <div className={cn("not-prose w-full", className)} {...props}>
          {children}
        </div>
      </ChainOfTurnContext.Provider>
    );
  }
);

export type ChainOfTurnHeaderProps = ComponentProps<"div"> & {
  path: string;
  loading?: boolean;
  /** A note on what the turn as a whole did, after the title. */
  summary?: ReactNode;
  /** How long the turn took, right-aligned and set in tabular figures. */
  duration?: ReactNode;
};

export const ChainOfTurnHeader = memo(
  ({
    path,
    loading,
    summary,
    duration,
    className,
    children,
    ...props
  }: ChainOfTurnHeaderProps) => {
    const { expandedPaths, togglePath } = useChainOfTurn();
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
export type ChainOfTurnStepStatus =
  | "complete"
  | "running"
  | "failed"
  | "denied";

const stepStatusStyles: Record<ChainOfTurnStepStatus, string> = {
  complete: "text-muted-foreground",
  running: "text-foreground",
  failed: "text-destructive",
  denied: "text-warning",
};

/**
 * Only the states worth interrupting for get a word. A finished step is the
 * norm, and labelling every one of them `Completed` would bury the rows that
 * actually need reading.
 */
const stepStatusLabels: Partial<Record<ChainOfTurnStepStatus, string>> = {
  running: "Running",
  failed: "Failed",
  denied: "Denied",
};

export type ChainOfTurnStepProps = ComponentProps<typeof DialogTrigger> & {
  path: string;
  icon?: LucideIcon;
  label: ReactNode;
  status?: ChainOfTurnStepStatus;
  /** A short note on what the step achieved, e.g. `650 lines`. */
  summary?: ReactNode;
  /** How long the step took, right-aligned and set in tabular figures. */
  duration?: ReactNode;
};

interface ChainOfTurnStepContextType {
  path: string;
}

const ChainOfTurnStepContext = createContext<ChainOfTurnStepContextType>({
  path: "",
});

export const ChainOfTurnStep = memo(
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
  }: ChainOfTurnStepProps) => {
    const { expandedPaths, togglePath } = useChainOfTurn();
    const isExpanded = expandedPaths.has(path);

    const handleOpenChange = useCallback(() => {
      togglePath(path);
    }, [togglePath, path]);

    const stepContextValue = useMemo(
      () => ({ isExpanded, path }),
      [isExpanded, path]
    );

    return (
      <ChainOfTurnStepContext.Provider value={stepContextValue}>
        <Dialog open={isExpanded} onOpenChange={handleOpenChange}>
          <DialogTrigger
            className={cn(
              "flex flex-col gap-2 w-full text-sm outline-none hover:underline",
              "fade-in-0 slide-in-from-top-2 animate-in",
              className
            )}
            {...props}
          >
            <div
              className={cn(
                "group/chain-step relative flex h-7 w-full items-center justify-between gap-2 text-sm transition-colors hover:text-foreground",
                stepStatusStyles[status]
              )}
            >
              <div className="relative flex h-full items-center gap-2 flex-1">
                <Icon className="shrink-0 size-4 group-hover/chain-step:hidden" />
                <ArrowUpRightIcon
                  className={cn(
                    "shrink-0 size-4 transition-transform hidden group-hover/chain-step:block"
                  )}
                />
                <span className="min-w-0 text-left">{label}</span>
                {stepStatusLabels[status] && (
                  <span className="shrink-0 text-xs">
                    {stepStatusLabels[status]}
                  </span>
                )}
                {summary && (
                  <span className="min-w-0 text-muted-foreground/70 text-xs">
                    {summary}
                  </span>
                )}
                {status === "running" && (
                  <Spinner className="size-3.5 shrink-0" />
                )}
              </div>
              <div className="relative flex h-full items-center gap-2 shrink-0">
                {duration && (
                  <span className="shrink-0 font-mono text-muted-foreground/70 text-xs tabular-nums">
                    {duration}
                  </span>
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
      </ChainOfTurnStepContext.Provider>
    );
  }
);

export type ChainOfTurnContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  path: string;
};

export const ChainOfTurnContent = memo(
  ({ path, className, children, ...props }: ChainOfTurnContentProps) => {
    const { expandedPaths, togglePath } = useChainOfTurn();
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

export type ChainOfTurnActionsProps = ComponentProps<"div">;

const stopPropagation = (e: React.SyntheticEvent) => {
  e.stopPropagation();
};

export const ChainOfTurnActions = ({
  className,
  children,
  ...props
}: ChainOfTurnActionsProps) => (
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

ChainOfTurn.displayName = "ChainOfTurn";
ChainOfTurnHeader.displayName = "ChainOfTurnHeader";
ChainOfTurnStep.displayName = "ChainOfTurnStep";
ChainOfTurnContent.displayName = "ChainOfTurnContent";
