import * as React from "react";

import { cn } from "@workspace/ui/lib/utils";

export type HoverScrollTextProps = {
  className?: string;
  /** 截断方向：`start` 省略开头，`end` 省略结尾。 */
  truncate?: "start" | "end";
  value: string;
};

/** 溢出时保留省略号；指针悬停后滑到被藏起来的一端。 */
export function HoverScrollText({
  className,
  truncate = "end",
  value,
}: HoverScrollTextProps) {
  const viewportRef = React.useRef<HTMLSpanElement>(null);
  const textRef = React.useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = React.useState(0);

  // 量出被藏起来的宽度，悬停时才滑这么多。
  React.useEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) {
      return;
    }

    const measure = () => {
      setOverflow(Math.max(0, text.scrollWidth - viewport.clientWidth));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [value]);

  const scrollStyle = {
    "--scroll-distance": `${overflow}px`,
    "--scroll-duration": `${Math.min(900, 220 + overflow * 8)}ms`,
  } as React.CSSProperties;

  return (
    <span
      className={cn("group/scroll relative block min-w-0", className)}
      ref={viewportRef}
      style={scrollStyle}
    >
      {/* 静止层保留省略号；悬停时让位给可以滑动的完整文字。 */}
      <span
        className={cn(
          "block truncate group-hover/scroll:opacity-0",
          truncate === "start" && "text-left [direction:rtl]"
        )}
      >
        <bdi dir="ltr">{value}</bdi>
      </span>
      <span
        aria-hidden="true"
        className="invisible absolute inset-0 overflow-hidden group-hover/scroll:visible"
      >
        <span
          className={cn(
            "block w-max whitespace-nowrap transition-transform ease-in-out duration-[var(--scroll-duration)] motion-reduce:transition-none",
            // start 的静止位先把文字左移，和省略号一起露出结尾；悬停滑回 0 露出开头。
            truncate === "start"
              ? "[transform:translateX(calc(-1*var(--scroll-distance)))] group-hover/scroll:[transform:translateX(0)]"
              : "group-hover/scroll:[transform:translateX(calc(-1*var(--scroll-distance)))]"
          )}
          ref={textRef}
        >
          {value}
        </span>
      </span>
    </span>
  );
}
