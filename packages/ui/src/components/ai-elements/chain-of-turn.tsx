import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { ChevronDownIcon, DotIcon, RouteIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

interface ChainOfTurnContext {
  expandedPaths: Set<string>;
  togglePath: (path: string) => void;
}

// Default noop for context default value
// oxlint-disable-next-line eslint(no-empty-function)
const noop = () => {};

const ChainOfTurnContext = createContext<ChainOfTurnContext | null>({
  // oxlint-disable-next-line eslint-plugin-unicorn(no-new-builtin)
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

export type ChainOfTurnHeaderProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  path: string;
};

export const ChainOfTurnHeader = memo(
  ({ path, className, children, ...props }: ChainOfTurnHeaderProps) => {
    const { expandedPaths, togglePath } = useChainOfTurn();
    const isExpanded = expandedPaths.has(path);

    const handleOpenChange = useCallback(() => {
      togglePath(path);
    }, [togglePath, path]);

    return (
      <Collapsible onOpenChange={handleOpenChange} open={isExpanded}>
        <CollapsibleTrigger
          className={cn(
            "flex h-4 w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
            className
          )}
          {...props}
          render={<div />}
        >
          <RouteIcon className="size-4" />
          <span className="text-left">{children ?? "Chain of Turn"}</span>
          <ChevronDownIcon
            className={cn(
              "size-4 transition-transform",
              isExpanded ? "rotate-0" : "-rotate-90"
            )}
          />
        </CollapsibleTrigger>
      </Collapsible>
    );
  }
);

const stepStatusStyles = {
  active: "text-foreground",
  complete: "text-muted-foreground",
  pending: "text-muted-foreground/50",
};

export type ChainOfTurnStepProps = ComponentProps<"div"> & {
  path: string;
  icon?: LucideIcon;
  label: ReactNode;
  description?: ReactNode;
  status?: "complete" | "active" | "pending";
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
    description,
    status = "complete",
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
        <Collapsible
          className={cn(
            "flex flex-col gap-2 text-sm",
            stepStatusStyles[status],
            "fade-in-0 slide-in-from-top-2 animate-in",
            className
          )}
          onOpenChange={handleOpenChange}
          open={isExpanded}
          {...props}
        >
          <CollapsibleTrigger
            className={cn(
              "relative mt-0.5 flex h-4 w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
              className
            )}
          >
            <Icon className="shrink-0 size-4" />
            <span className="text-left truncate">{label}</span>
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform",
                isExpanded ? "rotate-180" : "rotate-0"
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex-1 space-y-2 overflow-hidden">
            <div className="ml-2 border-l pl-4">
              {description && (
                <div className="text-muted-foreground text-xs">
                  {description}
                </div>
              )}
              {children}
            </div>
          </CollapsibleContent>
        </Collapsible>
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
            "mt-3 space-y-3",
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
    role="group"
    {...props}
  >
    {children}
  </div>
);

ChainOfTurn.displayName = "ChainOfTurn";
ChainOfTurnHeader.displayName = "ChainOfTurnHeader";
ChainOfTurnStep.displayName = "ChainOfTurnStep";
ChainOfTurnContent.displayName = "ChainOfTurnContent";
