import type * as React from "react";
import { useMeasure } from "react-use";
import {
  createContext,
  useContext,
} from "react";
import { cn } from "@workspace/ui/lib/utils";
import { Button } from "./button";
import { SquareArrowOutUpRightIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "./dialog";

type FrameVariant = "default" | "outline";

type FrameContextValue = {
  variant: FrameVariant;
  maxHeight?: number;
  overflowBehavior?: "dialog" | "scroll";
};

const FrameContext = createContext<FrameContextValue | undefined>(undefined);

function useFrameContext(): FrameContextValue {
  return useContext(FrameContext) ?? { variant: "default", overflowBehavior: "dialog" };
}

export type FrameProps = React.ComponentProps<"div"> & {
  variant: FrameVariant;
  maxHeight?: number;
  overflowBehavior?: "dialog" | "scroll";
}

export function Frame({
  className,
  variant = "default",
  maxHeight,
  overflowBehavior = "dialog",
  ...props
}: FrameProps): React.ReactElement {
  return (
    <FrameContext.Provider value={{ variant, maxHeight, overflowBehavior }}>
      <div
        className={cn("relative flex flex-col rounded-xl bg-muted *:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-1 overflow-hidden", {
          "border-1 shadow-none": variant === "outline",
          "border-1 shadow-sm": variant === "default",
        }, className)}
        data-slot="frame"
        {...props}
      />
    </FrameContext.Provider>
  );
}

export type FramePanelProps = React.ComponentProps<"div"> & {
  /** Shown inside the bottom fade when the panel overflows maxHeight, e.g. an "Expand" button. */
  maskContent?: React.ReactNode;
};

export function FramePanel({
  className,
  maskContent,
  style,
  ...props
}: FramePanelProps): React.ReactElement {
  const { variant, maxHeight, overflowBehavior } = useFrameContext();
  const [ref, { height }] = useMeasure();
  const isOverflowing = maxHeight && (height > maxHeight);

  return (
    <div
      className={cn("", {
        "p-1": variant === "default",
        "p-0": variant === "outline",
      })}
    >
      <div
        className={cn("relative bg-background bg-clip-padding p-5", {
            "rounded-[calc(var(--radius-xl)-2px)] border-1 shadow-xs/5": variant === "default",
            "overflow-hidden": isOverflowing && overflowBehavior === "dialog",
            "overflow-y-scroll": overflowBehavior === "scroll",
          },
          className
        )}
        style={maxHeight != null ? { maxHeight, ...style } : style}
        data-slot="frame-panel"
        {...props}
      >
        <div ref={ref}>
          {props.children}
        </div>
        {isOverflowing && overflowBehavior === "dialog" && (
          <div
            className="absolute inset-x-0 bottom-0 flex h-24 items-end justify-center bg-linear-to-t from-background pb-3"
            data-slot="frame-panel-mask"
          >
            <Dialog>
              <DialogTrigger render={<Button variant="secondary" size="sm" />}>
                <SquareArrowOutUpRightIcon data-icon="inline-start" />
                Open
              </DialogTrigger>
              <DialogContent className="bg-transparent ring-0 px-5 py-[min(10vh,10rem)] min-w-[72vw]" showCloseButton={false}>
                <Frame variant="outline">
                  <FrameHeader>
                    <FrameTitle>Title</FrameTitle>
                  </FrameHeader>
                  <FramePanel
                    className="overscroll-contain overflow-y-scroll"
                    style={{ maxHeight: "calc(min(56rem,100dvh - 2*min(10vh,10rem)) - 3rem)" }}
                  >
                    {props.children}
                  </FramePanel>
                </Frame>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>
    </div>
  );
}

export function FrameHeader({
  className,
  ...props
}: React.ComponentProps<"header">): React.ReactElement {
  const { variant } = useFrameContext();
  return (
    <header
      className={cn("flex flex-col px-5 py-3 pb-2", {
        "border-b-1": variant === "outline"
      })}
      data-slot="frame-panel-header"
      {...props}
    />
  );
}

export function FrameTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("font-medium text-sm text-accent-foreground", className)}
      data-slot="frame-panel-title"
      {...props}
    />
  );
}

export function FrameDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="frame-panel-description"
      {...props}
    />
  );
}

export function FrameFooter({
  className,
  ...props
}: React.ComponentProps<"footer">): React.ReactElement {
  return (
    <footer
      className={cn("px-5 py-4", className)}
      data-slot="frame-panel-footer"
      {...props}
    />
  );
}
