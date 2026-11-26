import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar";

import { assetUrl } from "../lib/asset-url";
import { initialOf } from "../lib/initial";
import { cn } from "../lib/utils";

export type BotAvatarSize = "xs" | "sm" | "md" | "lg";

/** One Bot size per avatar size. */
const AVATAR_SIZE = { xs: "xs", sm: "sm", md: "default", lg: "lg" } as const;

export interface BotAvatarProps {
  readonly botId: string;
  readonly name: string;
  /** The file name under the Bot's asset directory; without it the initial shows. */
  readonly avatarPath?: string | null;
  /** A value that changes when the Bot does, so a replaced image is fetched again. */
  readonly version?: number | string;
  readonly size?: BotAvatarSize;
  readonly className?: string;
}

/**
 * A Bot's face: the image it uploaded, else the first letter of its name.
 *
 * The root keeps `aria-label`: the sidebar locates a row by it, and a screen reader
 * uses it to say which Bot this is.
 */
export function BotAvatar({
  botId,
  name,
  avatarPath,
  version,
  size = "sm",
  className,
}: BotAvatarProps) {
  const hasImage =
    avatarPath !== undefined && avatarPath !== null && avatarPath !== "";

  return (
    <Avatar
      aria-label={name}
      className={cn("shrink-0", className)}
      size={AVATAR_SIZE[size]}
    >
      {hasImage ? (
        <AvatarImage
          alt={name}
          src={assetUrl({ kind: "bot", id: botId }, "avatar", version)}
        />
      ) : null}
      <AvatarFallback>{initialOf(name)}</AvatarFallback>
    </Avatar>
  );
}
