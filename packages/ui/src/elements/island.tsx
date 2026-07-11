import { cn } from "@workspace/ui/lib/utils";
import * as ResizablePrimitive from "react-resizable-panels";

import { useLayout } from "./layout-provider";

function IslandGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  const { layout } = useLayout();
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "island-group flex h-full w-full aria-[orientation=vertical]:flex-col",
        layout === "default" ? "p-0" : "p-2",
        className
      )}
      {...props}
    />
  );
}

function Island({ className, ...props }: ResizablePrimitive.PanelProps) {
  const { layout } = useLayout();
  return (
    <ResizablePrimitive.Panel
      data-slot="resizable-panel"
      {...props}
      className={cn(
        "island bg-background",
        layout === "default" ? "rounded-none" : "rounded-lg shadow",
        className
      )}
    />
  );
}

function IslandHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  const { layout } = useLayout();
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "island-handle relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        layout === "default" ? "w-px" : "w-2 bg-transparent",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  );
}

export { IslandHandle, Island, IslandGroup };
