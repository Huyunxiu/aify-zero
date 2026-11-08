import { cn } from "cn"
import * as ResizablePrimitive from "react-resizable-panels"

// 面板尺寸写在外层元素的内联 flex-grow 上（className 落在内层 div），
// 过渡只能从组挂到后代上。邻栏必须跟着重排，没有 transform 等价物。
const panelMotionClasses = [
  "motion-safe:[&_[data-slot=resizable-panel]]:transition-[flex-grow]",
  "motion-safe:[&_[data-slot=resizable-panel]]:duration-[250ms]",
  "motion-safe:[&_[data-slot=resizable-panel]]:ease-[cubic-bezier(0.23,1,0.32,1)]",
  // 拖动分隔条时尺寸要 1:1 跟手，过渡会带来迟滞。
  "[&:has([data-separator=active])_[data-slot=resizable-panel]]:transition-none",
]

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        panelMotionClasses,
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  variant = "line",
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  variant?: "line" | "gutter"
  withHandle?: boolean
}) {
  if (variant === "gutter") {
    return <ResizableGutterHandle className={className} {...props} />
  }

  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

/**
 * 侧栏式分隔条：画出来的线只有 1px，命中区要比它宽。
 *
 * 命中区靠 `after` 这个透明白块向两侧各外扩 3px 凑成 7px，并且不占布局宽度：
 * 1px 的线几乎点不中，鼠标稍微偏一点就落到旁边的面板上，悬停和拖动都失效。
 * 线本身、亮线和命中区都跟着同一个元素，所以 `group-hover` / `group-active`
 * 从命中区任意位置都能命中。
 */
function ResizableGutterHandle({
  className,
  ...props
}: ResizablePrimitive.SeparatorProps) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      data-variant="gutter"
      className={cn(
        "group/handle relative z-10 flex w-px shrink-0 cursor-col-resize touch-none items-center justify-center bg-transparent focus-visible:outline-hidden",
        "after:absolute after:inset-y-0 after:-inset-x-[3px] after:content-['']",
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize",
        "aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:-inset-y-[3px]",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "pointer-events-none h-full w-px bg-border transition-opacity duration-150 ease-out",
          "group-aria-[orientation=horizontal]/handle:h-px group-aria-[orientation=horizontal]/handle:w-full"
        )}
      />
      <span
        className={cn(
          "pointer-events-none absolute top-0 bottom-0 w-px group-aria-[orientation=vertical]/handle:bg-linear-to-b group-aria-[orientation=horizontal]/handle:bg-linear-to-r from-background via-foreground to-background opacity-0 transition-opacity duration-150 ease-out",
          "group-aria-[orientation=horizontal]/handle:h-px group-aria-[orientation=horizontal]/handle:w-full",
          "group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 group-active/handle:opacity-100",
          // 拖动中指针可能已经离开命中区，但状态还在，亮线不能跟着灭。
          "group-data-[separator=active]/handle:opacity-100"
        )}
      />
    </ResizablePrimitive.Separator>
  )
}

export { panelMotionClasses, ResizableHandle, ResizablePanel, ResizablePanelGroup }
