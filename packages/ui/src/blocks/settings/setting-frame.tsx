import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Separator } from "@workspace/ui/components/separator";
import { cn } from "@workspace/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

/**
 * 设置页的页头。
 *
 * 标题和副标题上下排列；没有副标题时与单独一行标题的占位一致。
 */
function SettingGroupHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="setting-group-header"
      className={cn("mb-4 mx-2 flex flex-col gap-1", className)}
      {...props}
    />
  );
}

function SettingGroupTitle({
  className,
  ...props
}: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="setting-group-title"
      className={cn("font-bold text-xl", className)}
      {...props}
    />
  );
}

function SettingGroupDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="setting-group-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function SettingGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="list"
      data-slot="item-group"
      className={cn(
        "group/item-group flex w-full flex-col rounded-lg bg-neutral-0 shadow-xs",
        className
      )}
      {...props}
    />
  );
}

/**
 * 设置项之间的分隔线。
 *
 * 左右各留 12px，与 `SettingItem` 的横向内边距对齐；分隔线不贴到分组边框。
 * 相邻的可点设置项被悬停时，分隔线让出位置：整行底色跨过分隔线才是连续的一段。
 */
function SettingSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <div
      data-slot="item-separator-row"
      className="px-3 transition-opacity duration-100 pointer-fine:has-[+a[data-slot=item]:hover]:opacity-0"
    >
      <Separator
        data-slot="item-separator"
        orientation="horizontal"
        className={cn("my-0", className)}
        {...props}
      />
    </div>
  );
}

const itemVariants = cva(
  cn(
    "group/item flex w-full flex-wrap items-center border text-sm transition-colors duration-100 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [a]:transition-colors [a]:hover:bg-muted",
    // 悬停底色贴到分组上下边框时，跟着分组自己的圆角走，不让直角顶穿卡片的圆角。
    "[a]:hover:first:rounded-t-[inherit] [a]:hover:last:rounded-b-[inherit]",
    // 悬停行下方的分隔线由这一行让位。CSS 选不到前面的兄弟，所以只能由被悬停
    // 的这一行去改后面的分隔线；上面的那条由 `SettingSeparator` 自己判断。
    "pointer-fine:[&:is(a):hover+[data-slot=item-separator-row]]:opacity-0"
  ),
  {
    variants: {
      variant: {
        default: "border-transparent",
        outline: "border-border",
        muted: "border-transparent",
      },
      size: {
        default: "gap-2.5 px-3 py-2.5",
        sm: "gap-2.5 px-3 py-2.5",
        xs: "gap-2 px-2.5 py-2 in-data-[slot=dropdown-menu-content]:p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function SettingItem({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(itemVariants({ variant, size, className })),
      },
      props
    ),
    render,
    state: {
      slot: "item",
      variant,
      size,
    },
  });
}

// 媒体始终在整行内垂直居中：设置项的媒体是图标或小 logo，
// 不随标题行对齐（说明文字的加入不应抬高图标）。
const itemMediaVariants = cva(
  "flex shrink-0 items-center justify-center gap-2 [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "[&_svg:not([class*='size-'])]:size-4",
        image:
          "size-10 overflow-hidden rounded-sm group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 [&_img]:size-full [&_img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function SettingItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

function SettingItemContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn(
        "flex flex-1 flex-col gap-1 group-data-[size=xs]/item:gap-0 [&+[data-slot=item-content]]:flex-none",
        className
      )}
      {...props}
    />
  );
}

function SettingItemTitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn(
        "line-clamp-1 flex w-fit items-center gap-2 text-sm leading-snug underline-offset-4",
        className
      )}
      {...props}
    />
  );
}

function SettingItemDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "line-clamp-2 text-left text-xs leading-normal font-normal text-muted-foreground group-data-[size=xs]/item:text-xs [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className
      )}
      {...props}
    />
  );
}

function SettingItemActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

function SettingItemHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className
      )}
      {...props}
    />
  );
}

function SettingItemFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className
      )}
      {...props}
    />
  );
}

export {
  SettingItem,
  SettingItemMedia,
  SettingItemContent,
  SettingItemActions,
  SettingGroup,
  SettingGroupHeader,
  SettingGroupTitle,
  SettingGroupDescription,
  SettingSeparator,
  SettingItemTitle,
  SettingItemDescription,
  SettingItemHeader,
  SettingItemFooter,
};
