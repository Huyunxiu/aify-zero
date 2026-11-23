import { BotIcon } from "lucide-react";

import { cn } from "../lib/utils";

export type BotAvatarSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<BotAvatarSize, string> = {
  sm: "size-5 text-xs [&_svg]:size-3.5",
  md: "size-7 text-sm [&_svg]:size-4",
  lg: "size-10 text-lg [&_svg]:size-5",
};

export interface BotAvatarProps {
  avatar?: string | null;
  name?: string;
  size?: BotAvatarSize;
  className?: string;
}

/** Compact identity glyph for a Bot: renders custom emoji when set, or a Bot icon. */
export function BotAvatar({
  avatar,
  name,
  size = "sm",
  className,
}: BotAvatarProps) {
  const glyph = avatar?.trim();

  return (
    <span
      aria-label={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground select-none",
        SIZE_CLASSES[size],
        className
      )}
    >
      {glyph ? (
        <span className="leading-none">{glyph}</span>
      ) : (
        <BotIcon aria-hidden="true" />
      )}
    </span>
  );
}
