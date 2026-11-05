import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"
import { X as XIcon } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "@workspace/ui/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

/**
 * 横向滚动的标签条。
 *
 * 标签多到放不下时只让这条滚动，不挤走右侧的操作区。
 */
function TabStripList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tab-strip-list"
      className={cn(
        "no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto",
        className
      )}
      {...props}
    />
  )
}

type TabStripTriggerProps = TabsPrimitive.Tab.Props & {
  /** 关闭这个标签；不传时不画关闭按钮。 */
  closeLabel?: string
  /** 标签文字左侧的图标。 */
  icon?: ReactNode
  onClose?: () => void
}

/**
 * 标签条里的一个标签。
 *
 * 根元素渲染成 `div`：标签里除了激活区还要放关闭按钮，原生 `button`
 * 不能嵌套 `button`。
 */
function TabStripTrigger({
  children,
  className,
  closeLabel,
  icon,
  onClose,
  ...props
}: TabStripTriggerProps) {
  const label =
    closeLabel ?? (typeof children === "string" ? children : undefined)

  return (
    <TabsPrimitive.Tab
      data-slot="tab-strip-trigger"
      nativeButton={false}
      render={<div />}
      className={cn(
        "group/tab relative isolate flex h-7 max-w-[200px] shrink-0 cursor-pointer select-none items-center overflow-hidden rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground focus-visible:outline-1 focus-visible:outline-ring",
        className
      )}
      {...props}
    >
      <span className="relative z-0 flex h-full min-w-0 flex-1 items-center gap-1.5 pr-3 pl-2">
        {icon}
        <span className="min-w-0 truncate">{children}</span>
      </span>
      {onClose === undefined ? null : (
        <>
          {/* 遮罩把标题尾部压进底色：关闭按钮悬在上面，标题就淡出去了。 */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-linear-to-l from-accent via-accent to-transparent opacity-0 transition-opacity group-hover/tab:opacity-100"
          />
          <button
            aria-label={label}
            className="absolute top-1/2 right-1 z-20 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm bg-foreground/10 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover/tab:opacity-100"
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
            // 焦点和按键冒泡到标签根元素会让标签被激活，关闭按钮要把它们截住。
            onFocus={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </>
      )}
    </TabsPrimitive.Tab>
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabStripList,
  TabStripTrigger,
  tabsListVariants,
}
