import * as React from "react";

import { isDesktopShell } from "../lib/desktop";
import { cn } from "../lib/utils";

type TitleBarProps = React.ComponentProps<"div">;

function TitleBar({ className, children }: TitleBarProps) {
  return (
    <div className={cn("h-12 [-webkit-app-region:drag] shrink-0", className)}>
      {children}
    </div>
  );
}

/**
 * 只在桌面壳里渲染的窗口拖拽区。
 *
 * 桌面窗口没有系统标题栏，要靠这条区域拖动窗口、给红绿灯让位。浏览器没有
 * 窗口装饰，同样的留白只会白占高度。
 *
 * @param props - 与 `TitleBar` 相同。
 * @returns 桌面端是标题栏，其他环境是 null。
 */
function DesktopTitleBar(props: TitleBarProps) {
  return isDesktopShell ? <TitleBar {...props} /> : null;
}

export { TitleBar, DesktopTitleBar, type TitleBarProps };
