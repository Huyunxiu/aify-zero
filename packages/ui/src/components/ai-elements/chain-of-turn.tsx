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
  ShieldCheckIcon,
  ShieldQuestionIcon,
  ShieldXIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
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

/**
 * The request behind a step that was held for the user's decision.
 *
 * A subset of the tool part's own `approval`, restated here so the activity
 * list stays independent of the agent protocol: the fields named are the ones
 * this UI renders, and a change to any of them is a compile error at the call
 * site rather than a panel that quietly renders nothing.
 */
export type AgentActivityApprovalRequest = {
  /** Names the request an answer has to be addressed to. */
  id: string;
  /** The user's answer; undefined while the request is still open. */
  approved?: boolean;
  /** What was asked about, in the asker's own words — a command, a path. */
  descriptor?: unknown;
  /** Why the call was held. */
  requestReason?: string;
  /** Approved by a policy rather than by the user. */
  isAutomatic?: boolean;
  signature?: string;
  inputSchemaInput?: unknown;
};

/**
 * The text a request can be shown by: the descriptor its asker wrote, or the
 * input the schema was given. Either may be absent, and neither is guaranteed
 * to be a string, so a structured one is shown as JSON rather than as
 * `[object Object]`.
 */
const approvalSubject = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const APPROVAL_RESULT = {
  approved: {
    frame: "border-success-foreground/30 bg-success-foreground/5",
    icon: "text-success-foreground",
  },
  denied: {
    frame: "border-destructive/30 bg-destructive/10",
    icon: "text-destructive",
  },
} as const;

export type AgentActivityApprovalProps = {
  approval: AgentActivityApprovalRequest;
  /**
   * Called with the request's id and the user's decision when one of the two
   * buttons is pressed. Absent, the request is shown read-only — a caller with
   * no way to send an answer should not offer one.
   */
  onRespond?: (approvalId: string, approved: boolean) => void;
  className?: string;
};

/**
 * The decision a held step is asking for, shown at the top of the step's own
 * dialog — the call's input sits below it, which is what there is to review.
 *
 * A request is answered once, so the buttons go out together: the second is
 * locked while the first is in flight, and the panel turns into a read-only
 * result as soon as the answer comes back and rewrites `approved`.
 */
export const AgentActivityApproval = memo(
  ({ approval, onRespond, className }: AgentActivityApprovalProps) => {
    // Which answer is being sent, so a fast second click cannot answer the same
    // request twice. Cleared when the answer lands and rewrites `approved`.
    const [answering, setAnswering] = useState<"approve" | "deny" | null>(null);

    useEffect(() => {
      setAnswering(null);
    }, [approval.approved]);

    const handleApprove = useCallback(() => {
      setAnswering("approve");
      onRespond?.(approval.id, true);
    }, [approval.id, onRespond]);

    const handleDeny = useCallback(() => {
      setAnswering("deny");
      onRespond?.(approval.id, false);
    }, [approval.id, onRespond]);

    // A policy-approved request never put a question to the user, and an
    // answered one is history: both read out as a result, not as a form.
    const autoApproved =
      approval.approved === undefined && approval.isAutomatic === true;
    const isOpen = approval.approved === undefined && !autoApproved;

    if (!isOpen) {
      const approved = approval.approved === true || autoApproved;
      const tone = approved ? APPROVAL_RESULT.approved : APPROVAL_RESULT.denied;
      const Icon = approved ? ShieldCheckIcon : ShieldXIcon;

      return (
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm",
            tone.frame,
            className
          )}
        >
          <Icon className={cn("size-4 shrink-0", tone.icon)} />
          <span className={cn("font-medium", tone.icon)}>
            {autoApproved ? "Approved automatically" : approved ? "Approved" : "Denied"}
          </span>
        </div>
      );
    }

    const subject = approvalSubject(
      approval.descriptor ?? approval.inputSchemaInput
    );

    return (
      <div
        className={cn(
          "flex flex-col gap-3 rounded-xl border border-warning-foreground/30 bg-warning-foreground/5 p-3",
          className
        )}
      >
        <div className="flex items-start gap-2">
          <ShieldQuestionIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium text-sm text-warning-foreground">
              Awaiting your approval
            </div>
            {approval.requestReason && (
              <div className="text-muted-foreground text-xs">
                {approval.requestReason}
              </div>
            )}
            {subject && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 px-2 py-1.5 font-mono text-xs">
                {subject}
              </pre>
            )}
          </div>
        </div>
        {onRespond && (
          <div className="flex items-center justify-end gap-2">
            <Button
              disabled={answering !== null}
              loading={answering === "deny"}
              onClick={handleDeny}
              size="sm"
              variant="outline"
            >
              Deny
            </Button>
            <Button
              disabled={answering !== null}
              loading={answering === "approve"}
              onClick={handleApprove}
              size="sm"
            >
              Approve
            </Button>
          </div>
        )}
      </div>
    );
  }
);

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
  | "approval";

export type AgentActivityStepProps = ComponentProps<typeof DialogTrigger> & {
  path: string;
  icon?: LucideIcon;
  label: ReactNode;
  status?: AgentActivityStepStatus;
  /** A short note on what the step achieved, e.g. `650 lines`. */
  summary?: ReactNode;
  /** How long the step took, right-aligned and set in tabular figures. */
  duration?: ReactNode;
  /**
   * The approval this step is held on or was granted, when it has one. An open
   * request is answered from the dialog; an answered one reads out as a result.
   */
  approval?: AgentActivityApprovalRequest;
  /** Called with the approval's id and the user's decision. */
  onRespondApproval?: (approvalId: string, approved: boolean) => void;
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
    approval,
    onRespondApproval,
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
                {status === "approval" && (
                  <ShieldQuestionIcon className="size-3.5 shrink-0 text-warning-foreground" />
                )}
              </div>
            </div>
          </DialogTrigger>
          <DialogContent
            className="bg-transparent ring-0 px-0 py-0 min-w-[72vw]"
            showCloseButton={false}
          >
            <div className="flex max-h-[calc(100dvh-2*min(10vh,10rem))] flex-col gap-4 overflow-y-auto overscroll-contain px-5">
              {approval && (
                <AgentActivityApproval
                  approval={approval}
                  onRespond={onRespondApproval}
                />
              )}
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
AgentActivityApproval.displayName = "AgentActivityApproval";
AgentActivityStep.displayName = "AgentActivityStep";
AgentActivityContent.displayName = "AgentActivityContent";
