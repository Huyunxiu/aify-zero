/**
 * 内容区里的提示。
 *
 * 一个视图没有内容可画时（还没选中文件、文件不能预览、目录不是仓库），要说的
 * 话就放在内容区正中间：它解释的是这一块为什么空的，所以不占用别处的位置，
 * 也不弹全局提示。
 */
import type * as React from "react";

export type HintProps = {
  readonly children: React.ReactNode;
  /** `destructive` 用于真正的失败；其余情况都用次要色。 */
  readonly tone?: "muted" | "destructive";
};

export function Hint({ children, tone = "muted" }: HintProps) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p
        className={
          tone === "destructive"
            ? "text-center text-destructive text-sm"
            : "text-center text-muted-foreground text-sm"
        }
      >
        {children}
      </p>
    </div>
  );
}
