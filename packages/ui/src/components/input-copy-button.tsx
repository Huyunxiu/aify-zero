import type { Button as ButtonPrimitive } from "@base-ui/react/button";
import { CheckIcon, CopyIcon } from "lucide-react";

import { cn } from "@workspace/ui/lib/utils";

import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { Button } from "./button";
import { HoverScrollText } from "./hover-scroll-text";

export type InputCopyButtonProps = ButtonPrimitive.Props & {
  /** 复制动作的辅助说明，给读屏用。 */
  label: string;
  /** 显示的文字；不传就显示 `value`。 */
  text?: string;
  /** 截断方向：`start` 省略开头，`end` 省略结尾。 */
  truncate?: "start" | "end";
  /** 复制的内容；为空时按钮不可用。 */
  value: string | undefined;
};

export function InputCopyButton({
  className,
  label,
  text,
  truncate = "end",
  value,
  ...props
}: InputCopyButtonProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <Button
      className={cn(
        "group/copy min-w-0 shrink justify-start text-muted-foreground",
        className
      )}
      disabled={!value}
      onClick={() => {
        if (value) {
          copyToClipboard(value);
        }
      }}
      variant="ghost"
      {...props}
    >
      <HoverScrollText
        className="flex-1"
        truncate={truncate}
        value={text ?? value ?? ""}
      />
      <span className="sr-only">{label}</span>
      {/* 指针或焦点进来时再露出复制图标，平时把位置留出来。 */}
      <span
        aria-hidden="true"
        className={cn(
          "shrink-0 transition-opacity",
          isCopied
            ? "opacity-100"
            : "opacity-0 group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100"
        )}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </span>
    </Button>
  );
}
