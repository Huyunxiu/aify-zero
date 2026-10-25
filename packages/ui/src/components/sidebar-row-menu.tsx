import { EllipsisIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { SidebarMenuAction } from "./sidebar";

/** 右键落点做成一个零尺寸的锚点，菜单就能贴着鼠标出现。 */
type PointerAnchor = {
  getBoundingClientRect: () => DOMRect;
};

/**
 * 触发按钮所在的行：普通菜单项和子菜单项都算。
 *
 * 用 `data-sidebar` 而不是 `data-slot`：项目行整行是 `Collapsible` 的渲染结果，
 * Base UI 会把自己的 `data-slot="collapsible"` 写到同一个 `li` 上，把
 * `data-slot="sidebar-menu-item"` 顶掉。
 */
const ROW_SELECTOR = '[data-sidebar="menu-item"], [data-sidebar="menu-sub-item"]';

type SidebarRowMenuProps = {
  /** 触发按钮的无障碍名称，比如「项目操作」。 */
  label: string;
  children: ReactNode;
  /** 子菜单行高度更矮，调用方可以用它调触发按钮的定位。 */
  className?: string;
};

/**
 * 侧边栏每一行最右侧的设置按钮：平时藏起来，鼠标停在这一行、键盘焦点落进
 * 这一行，或者菜单已经展开时才露出来。行元素需要带 `group/item`。
 *
 * 整行右键同样打开这个菜单：监听器挂在行的 `li` 上，菜单锚定在鼠标位置；
 * 齿轮按钮则仍锚定在按钮自己身上。菜单内容由调用方给（`DropdownMenuItem`）。
 */
export function SidebarRowMenu({
  label,
  children,
  className,
}: SidebarRowMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<PointerAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const row = triggerRef.current?.closest<HTMLElement>(ROW_SELECTOR);
    if (!row) {
      return;
    }

    function handleContextMenu(event: MouseEvent) {
      event.preventDefault();
      // 项目行里还嵌着子会话行，拦住冒泡，免得两条行各开一个菜单。
      event.stopPropagation();
      const { clientX, clientY } = event;
      setAnchor({
        getBoundingClientRect: () =>
          DOMRect.fromRect({ x: clientX, y: clientY, width: 0, height: 0 }),
      });
      setOpen(true);
    }

    row.addEventListener("contextmenu", handleContextMenu);
    return () => row.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        // 关掉之后回到齿轮锚点，别让上一次的右键位置留在那里。
        if (!nextOpen) {
          setAnchor(null);
        }
      }}
    >
      <DropdownMenuTrigger
        onPointerDown={() => {
          setAnchor(null);
        }}
        render={
          <SidebarMenuAction
            ref={triggerRef}
            aria-label={label}
            className={[
              className,
              "group-hover/item:opacity-100 group-focus-within/item:opacity-100 text-sidebar-foreground/70 hover:bg-foreground-8",
              // 右键打开时鼠标很快就移到菜单上了，靠 open 把按钮留在原地；
              // 触屏没有 hover，直接常驻，免得操作入口不可达。
              open ? "opacity-100" : "opacity-0 max-md:opacity-100",
            ]
              .filter(Boolean)
              .join(" ")}
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        anchor={anchor ?? undefined}
        // 贴着鼠标时向右展开；贴着齿轮时向右收，免得顶出侧边栏。
        align={anchor ? "start" : "end"}
        sideOffset={anchor ? 2 : 4}
        className="w-auto min-w-50"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
